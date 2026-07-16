import { isPlainRecord } from '@lobechat/utils/object';
import { z } from 'zod';

import type { PlatformUserConnectorBindingItem } from '@/database/schemas/platform/connectors';

import { connectorSharedCredentialSchema } from '../../contracts/platformConnectors';
import { redactDeep } from '../../security/redaction';
import { resolveConnectorSecretVersion } from './catalogSnapshot';
import type { ConnectorCatalogSecretStore } from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { PlatformConnectorContractError } from './errors';
import type {
  ConnectorOperationProof,
  ConnectorOperationSnapshotService,
} from './operationSnapshot';
import {
  assertConnectorScopesAllowed,
  resolveConnectorConfirmationPolicy,
  resolveEffectiveConnectorToolPolicy,
} from './toolPolicy';

const storedOAuthTokenSchema = z
  .object({
    accessToken: z.string().min(1).max(32_768),
    refreshToken: z.string().min(1).max(32_768).optional(),
  })
  .strict();

const DEFAULT_SHARED_RATE_LIMIT = 30;
const DEFAULT_SHARED_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_RATE_LIMIT_SCOPES = 10_000;
const DEFAULT_REFRESH_WINDOW_MS = 60_000;

export interface ConnectorRuntimePolicyRecord {
  agentAllowed: boolean;
  legacyRequiresConfirmation?: boolean;
  userEnabled: boolean;
}

export interface ConnectorRuntimePolicyResolver {
  resolve: (params: {
    agentId: string;
    connectorId: string;
    connectorKey: string;
    toolKey: string;
    userId: string;
  }) => Promise<ConnectorRuntimePolicyRecord>;
}

export interface ConnectorRuntimeAuditWriter {
  appendSharedCall: (params: {
    connectorId: string;
    operationId: string;
    outcome: 'allowed' | 'denied' | 'failed' | 'rate_limited';
    toolKey: string;
    userId: string;
  }) => Promise<void>;
}

export interface ConnectorRuntimeRateLimiter {
  consume: (scope: string) => boolean | Promise<boolean>;
}

interface RateLimitEntry {
  count: number;
  windowStartedAt: number;
}

/** Process-local fast guard; callers can inject a distributed implementation. */
export class BoundedConnectorRuntimeRateLimiter implements ConnectorRuntimeRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly options: {
      clock?: () => number;
      maxEntries?: number;
      maxRequests?: number;
      windowMs?: number;
    } = {},
  ) {}

  consume = (scope: string): boolean => {
    const now = (this.options.clock ?? Date.now)();
    const windowMs = this.options.windowMs ?? DEFAULT_SHARED_RATE_WINDOW_MS;
    const maxRequests = this.options.maxRequests ?? DEFAULT_SHARED_RATE_LIMIT;
    const maxEntries = Math.min(
      this.options.maxEntries ?? DEFAULT_MAX_RATE_LIMIT_SCOPES,
      DEFAULT_MAX_RATE_LIMIT_SCOPES,
    );
    const existing = this.entries.get(scope);
    const entry =
      !existing || now - existing.windowStartedAt >= windowMs
        ? { count: 0, windowStartedAt: now }
        : existing;
    entry.count += 1;
    this.entries.delete(scope);
    this.entries.set(scope, entry);
    while (this.entries.size > Math.max(1, maxEntries)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.count <= Math.max(1, maxRequests);
  };
}

export interface PlatformConnectorRuntimeAdapterDependencies {
  audit: ConnectorRuntimeAuditWriter;
  bindingLoader: (
    userId: string,
    connectorId: string,
  ) => Promise<PlatformUserConnectorBindingItem | undefined>;
  clock?: () => Date;
  outbound: Pick<ConnectorOutboundClient, 'preflight' | 'requestJson'>;
  policy: ConnectorRuntimePolicyResolver;
  rateLimiter: ConnectorRuntimeRateLimiter;
  refreshBinding?: (userId: string, connectorId: string) => Promise<void>;
  secrets: ConnectorCatalogSecretStore;
  snapshots: Pick<ConnectorOperationSnapshotService, 'resolveExact'>;
}

export interface PlatformConnectorRuntimeInvocation {
  agentId: string;
  arguments: string | Record<string, unknown>;
  humanApproved: boolean;
  proof: ConnectorOperationProof;
  toolKey: string;
  userId: string;
}

export interface PlatformConnectorRuntimeResult {
  confirmation: 'always' | null;
  content: string;
  state?: Record<string, unknown>;
  success: true;
}

/** Policy/ownership/preflight always precede secret resolution and outbound execution. */
export class PlatformConnectorRuntimeAdapter {
  constructor(private readonly dependencies: PlatformConnectorRuntimeAdapterDependencies) {}

  execute = async (
    invocation: PlatformConnectorRuntimeInvocation,
  ): Promise<PlatformConnectorRuntimeResult> => {
    const snapshot = await this.dependencies.snapshots.resolveExact(invocation.proof);
    if (snapshot.proof.operationId !== invocation.proof.operationId) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    const connector = snapshot.payload.connector;
    const tool = snapshot.payload.tools.find(
      (candidate) => candidate.toolKey === invocation.toolKey,
    );
    if (!tool) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');

    const policyRecord = await this.dependencies.policy.resolve({
      agentId: invocation.agentId,
      connectorId: connector.id,
      connectorKey: connector.key,
      toolKey: tool.toolKey,
      userId: invocation.userId,
    });
    const effectivePolicy = resolveEffectiveConnectorToolPolicy({
      agentAllowed: policyRecord.agentAllowed,
      platformPolicy: tool.platformPolicy,
      userEnabled: policyRecord.userEnabled,
    });
    if (!effectivePolicy.allowed) {
      if (connector.credentialMode === 'shared_service_account') {
        await this.auditShared(invocation, connector.id, 'denied');
      }
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    const confirmation = resolveConnectorConfirmationPolicy({
      legacyRequiresConfirmation: policyRecord.legacyRequiresConfirmation,
      requiresConfirmation: tool.requiresConfirmation,
      riskLevel: tool.riskLevel,
    });
    if (confirmation && !invocation.humanApproved) {
      if (connector.credentialMode === 'shared_service_account') {
        await this.auditShared(invocation, connector.id, 'denied');
      }
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CONFIRMATION_REQUIRED');
    }

    try {
      const args = parseArguments(invocation.arguments);
      let headers: Record<string, string> | undefined;
      if (connector.credentialMode === 'shared_service_account') {
        const allowed = await this.dependencies.rateLimiter.consume(
          `${connector.id}:${invocation.userId}`,
        );
        if (!allowed) {
          await this.auditShared(invocation, connector.id, 'rate_limited');
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RATE_LIMITED');
        }
        await this.dependencies.outbound.preflight(connector.endpoint);
        const secret = await resolveConnectorSecretVersion(
          this.dependencies.secrets,
          connector.id,
          'sharedSecret',
          connector.sharedSecretFingerprint,
        );
        headers = sharedCredentialHeaders(connectorSharedCredentialSchema.parse(secret.value));
      } else if (connector.credentialMode === 'per_user_oauth') {
        const allowedScopes = connector.oauthConfig?.scopes ?? [];
        let binding = await this.loadBinding(
          invocation,
          connector.id,
          snapshot.proof.publishedRevision,
          allowedScopes,
        );
        await this.dependencies.outbound.preflight(connector.endpoint);
        const now = (this.dependencies.clock ?? (() => new Date()))();
        const tokenExpiresAt = binding.expiresAt;
        if (
          tokenExpiresAt &&
          tokenExpiresAt.getTime() - now.getTime() <= DEFAULT_REFRESH_WINDOW_MS &&
          this.dependencies.refreshBinding
        ) {
          try {
            await this.dependencies.refreshBinding(invocation.userId, connector.id);
            binding = await this.loadBinding(
              invocation,
              connector.id,
              snapshot.proof.publishedRevision,
              allowedScopes,
            );
          } catch (error) {
            if (tokenExpiresAt <= now) throw error;
          }
        }
        if (binding.expiresAt && binding.expiresAt <= now) {
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_BINDING_NOT_FOUND');
        }
        const tokenSecret = await this.dependencies.secrets.resolveSecretRef({
          connectorId: connector.id,
          ref: binding.oauthTokenRef!,
          slot: 'oauthBindingToken',
        });
        const token = storedOAuthTokenSchema.safeParse(tokenSecret?.value);
        if (
          !tokenSecret ||
          tokenSecret.ref !== binding.oauthTokenRef ||
          tokenSecret.fingerprint !== binding.tokenFingerprint ||
          !token.success
        ) {
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
        }
        headers = { Authorization: `Bearer ${token.data.accessToken}` };
      } else {
        await this.dependencies.outbound.preflight(connector.endpoint);
      }
      const response = await this.dependencies.outbound.requestJson({
        body: {
          id: `${invocation.proof.operationId}:${tool.toolKey}`,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: tool.toolKey },
        },
        headers,
        method: 'POST',
        operation: 'runtime',
        secretBearing: headers !== undefined,
        url: connector.endpoint,
      });
      const result = parseRuntimeResponse(response.body);
      if (connector.credentialMode === 'shared_service_account') {
        await this.auditShared(invocation, connector.id, 'allowed');
      }
      return { confirmation, ...result, success: true };
    } catch (error) {
      if (
        connector.credentialMode === 'shared_service_account' &&
        !(
          error instanceof PlatformConnectorContractError &&
          error.code === 'PLATFORM_CONNECTOR_RATE_LIMITED'
        )
      ) {
        await this.auditShared(invocation, connector.id, 'failed');
      }
      if (error instanceof PlatformConnectorContractError) throw error;
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
  };

  private auditShared = async (
    invocation: PlatformConnectorRuntimeInvocation,
    connectorId: string,
    outcome: 'allowed' | 'denied' | 'failed' | 'rate_limited',
  ): Promise<void> => {
    await this.dependencies.audit.appendSharedCall({
      connectorId,
      operationId: invocation.proof.operationId,
      outcome,
      toolKey: invocation.toolKey,
      userId: invocation.userId,
    });
  };

  private loadBinding = async (
    invocation: PlatformConnectorRuntimeInvocation,
    connectorId: string,
    publishedRevision: number,
    allowedScopes: string[],
  ): Promise<PlatformUserConnectorBindingItem> => {
    const binding = await this.dependencies.bindingLoader(invocation.userId, connectorId);
    if (
      !binding ||
      binding.userId !== invocation.userId ||
      binding.connectorId !== connectorId ||
      binding.publishedRevision !== publishedRevision ||
      binding.status !== 'connected' ||
      binding.revokedAt ||
      !binding.oauthTokenRef ||
      !binding.tokenFingerprint
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
    }
    assertConnectorScopesAllowed(allowedScopes, binding.scopes);
    return binding;
  };
}

const parseArguments = (value: string | Record<string, unknown>): Record<string, unknown> => {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
  }
  if (!isPlainRecord(parsed)) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
  }
  return parsed;
};

const sharedCredentialHeaders = (
  credential: z.infer<typeof connectorSharedCredentialSchema>,
): Record<string, string> => ({
  ...credential.headers,
  ...(credential.apiKey ? { Authorization: `Bearer ${credential.apiKey}` } : {}),
  ...(credential.bearerToken ? { Authorization: `Bearer ${credential.bearerToken}` } : {}),
  ...(credential.username && credential.password
    ? {
        Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
      }
    : {}),
});

const parseRuntimeResponse = (
  body: unknown,
): { content: string; state?: Record<string, unknown> } => {
  if (!isPlainRecord(body) || 'error' in body) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
  }
  const value = 'result' in body ? body.result : body;
  const redacted = redactDeep(value);
  const content = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  return {
    content,
    ...(isPlainRecord(redacted) ? { state: redacted } : {}),
  };
};

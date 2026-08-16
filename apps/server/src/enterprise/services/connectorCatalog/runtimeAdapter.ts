import { createHash } from 'node:crypto';

import { isPlainRecord } from '@lobechat/utils/object';
import { z } from 'zod';

import type { PlatformUserConnectorBindingItem } from '@/database/schemas/platform/connectors';

import {
  collectConnectorSecretLeaves,
  connectorSharedCredentialReadSchema,
} from '../../contracts/platformConnectors';
import { redactDeep } from '../../security/redaction';
import { resolveConnectorSecretVersion } from './catalogSnapshot';
import type { ConnectorCatalogSecretStore } from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { PlatformConnectorContractError } from './errors';
import type {
  ConnectorOperationProof,
  ConnectorOperationSnapshotService,
} from './operationSnapshot';
import type {
  ConnectorRuntimeExecutionJournal,
  ConnectorRuntimeJournalToken,
} from './runtimeExecutionJournal';
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
    idempotencyKey?: string;
    operationId: string;
    outcome: 'admitted' | 'allowed' | 'denied' | 'failed' | 'rate_limited' | 'unknown';
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
  assertCurrentPublished?: () => Promise<void>;
  audit: ConnectorRuntimeAuditWriter;
  bindingLoader: (
    userId: string,
    connectorId: string,
  ) => Promise<PlatformUserConnectorBindingItem | undefined>;
  clock?: () => Date;
  journal: ConnectorRuntimeExecutionJournal;
  outbound: Pick<ConnectorOutboundClient, 'preflight' | 'requestJson'>;
  policy: ConnectorRuntimePolicyResolver;
  rateLimiter: ConnectorRuntimeRateLimiter;
  refreshBinding?: (
    userId: string,
    connectorId: string,
    publishedRevision: number,
  ) => Promise<void>;
  secrets: ConnectorCatalogSecretStore;
  snapshots: Pick<ConnectorOperationSnapshotService, 'resolveExact'>;
}

export interface PlatformConnectorRuntimeInvocation {
  agentId: string;
  arguments: string | Record<string, unknown>;
  /**
   * Org connector-governance shared OAuth identity: when set, the
   * per_user_oauth binding is loaded and refreshed for THIS user id (the
   * governance-designated shared auth owner) instead of the invoking
   * `userId`, so every user runs on the owner's authorization. The binding
   * ownership guard then compares against this effective identity — it still
   * fails closed on any binding belonging to a third identity. Absent →
   * per-user behavior, byte-identical to today. Audit / journal records keep
   * the invoking `userId` (the actual actor).
   */
  effectiveBindingUserId?: string;
  humanApproved: boolean;
  proof: ConnectorOperationProof;
  toolCallId: string;
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

    let journalToken: ConnectorRuntimeJournalToken | undefined;
    let outboundStarted = false;
    try {
      const args = parseArguments(invocation.arguments);
      let headers: Record<string, string> | undefined;
      const taintedValues: string[] = [];
      if (connector.credentialMode === 'shared_service_account') {
        const shared = await this.resolveSharedCredentials(invocation, connector);
        headers = shared.headers;
        taintedValues.push(...shared.taintedValues);
      } else if (connector.credentialMode === 'per_user_oauth') {
        const oauth = await this.resolveOAuthCredentials(
          invocation,
          connector,
          snapshot.proof.publishedRevision,
        );
        headers = oauth.headers;
        taintedValues.push(...oauth.taintedValues);
      } else {
        await this.dependencies.outbound.preflight(connector.endpoint);
      }
      // Emergency archive/current-state guard must precede idempotency reservation.
      // A rejected stale manifest must not consume a toolCall key or create a
      // running journal entry that later reconciles as unknown.
      await this.dependencies.assertCurrentPublished?.();
      if (connector.credentialMode === 'shared_service_account') {
        const reserved = await this.reserveSharedJournal(invocation, connector, tool, args);
        if (reserved.kind === 'replay') return reserved.result;
        journalToken = reserved.token;
      }
      try {
        // Close the archive race opened between the pre-reservation check and
        // the shared idempotency insert. This remains immediately adjacent to
        // the first possible external side effect.
        await this.dependencies.assertCurrentPublished?.();
      } catch (error) {
        if (journalToken) {
          await this.cancelJournal(journalToken);
          journalToken = undefined;
        }
        throw error;
      }
      if (journalToken) {
        try {
          await this.dependencies.journal.arm(journalToken);
        } catch {
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
        }
      }
      outboundStarted = true;
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
      const result = parseRuntimeResponse(response.body, taintedValues);
      const executionResult = { confirmation, ...result, success: true as const };
      if (connector.credentialMode === 'shared_service_account') {
        try {
          await this.completeJournal(journalToken!, executionResult);
        } catch (error) {
          console.error('[connector-runtime] terminal result journal pending', {
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          });
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
        }
        try {
          await this.deliverJournalAudit(journalToken!);
        } catch (error) {
          console.error('[connector-runtime] terminal audit delivery pending', {
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      }
      return executionResult;
    } catch (error) {
      if (shouldAuditSharedFailure(connector, outboundStarted, journalToken, error)) {
        try {
          await this.auditShared(invocation, connector.id, 'failed');
        } catch (auditError) {
          console.error('[connector-runtime] failure audit delivery pending', {
            errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
          });
        }
      }
      if (error instanceof PlatformConnectorContractError) throw error;
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
  };

  private reserveSharedJournal = async (
    invocation: PlatformConnectorRuntimeInvocation,
    connector: { id: string },
    tool: { toolKey: string },
    args: Record<string, unknown>,
  ): Promise<
    | { kind: 'replay'; result: PlatformConnectorRuntimeResult }
    | { kind: 'reserved'; token: ConnectorRuntimeJournalToken }
  > => {
    const journal = await this.dependencies.journal.begin({
      connectorId: connector.id,
      operationId: invocation.proof.operationId,
      requestFingerprint: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      toolCallId: invocation.toolCallId,
      toolKey: tool.toolKey,
      userId: invocation.userId,
    });
    if (journal.status === 'reserved') {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    if (journal.status === 'replay') {
      if (journal.auditPending) {
        try {
          await this.deliverJournalAudit(journal.token);
        } catch (error) {
          console.error('[connector-runtime] terminal audit reconciliation pending', {
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      }
      return { kind: 'replay', result: journal.result };
    }
    return { kind: 'reserved', token: journal.token };
  };

  private resolveOAuthCredentials = async (
    invocation: PlatformConnectorRuntimeInvocation,
    connector: {
      id: string;
      endpoint: string;
      oauthConfig: { scopes?: string[] } | null;
    },
    publishedRevision: number,
  ): Promise<{ headers: Record<string, string>; taintedValues: string[] }> => {
    const allowedScopes = connector.oauthConfig?.scopes ?? [];
    let binding = await this.loadBinding(
      invocation,
      connector.id,
      publishedRevision,
      allowedScopes,
    );
    await this.dependencies.outbound.preflight(connector.endpoint);
    binding = await this.reloadExactBinding(invocation, binding, allowedScopes);
    const now = (this.dependencies.clock ?? (() => new Date()))();
    const tokenExpiresAt = binding.expiresAt;
    if (
      tokenExpiresAt &&
      tokenExpiresAt.getTime() - now.getTime() <= DEFAULT_REFRESH_WINDOW_MS &&
      this.dependencies.refreshBinding
    ) {
      // Refresh runs under the effective binding identity: the shared
      // auth owner while governance designates one, else the invoking user.
      await this.dependencies.refreshBinding(
        invocation.effectiveBindingUserId ?? invocation.userId,
        connector.id,
        publishedRevision,
      );
      binding = await this.loadBinding(invocation, connector.id, publishedRevision, allowedScopes);
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
    await this.reloadExactBinding(invocation, binding, allowedScopes);
    const headers = { Authorization: `Bearer ${token.data.accessToken}` };
    return {
      headers,
      taintedValues: [
        token.data.accessToken,
        ...(token.data.refreshToken ? [token.data.refreshToken] : []),
        ...Object.values(headers),
      ],
    };
  };

  private resolveSharedCredentials = async (
    invocation: PlatformConnectorRuntimeInvocation,
    connector: {
      endpoint: string;
      id: string;
      sharedSecretFingerprint: string | null;
    },
  ): Promise<{ headers: Record<string, string>; taintedValues: string[] }> => {
    const allowed = await this.dependencies.rateLimiter.consume(
      `${connector.id}:${invocation.userId}`,
    );
    if (!allowed) {
      await this.auditShared(invocation, connector.id, 'rate_limited');
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RATE_LIMITED');
    }
    await this.auditShared(invocation, connector.id, 'admitted');
    await this.dependencies.outbound.preflight(connector.endpoint);
    const secret = await resolveConnectorSecretVersion(
      this.dependencies.secrets,
      connector.id,
      'sharedSecret',
      connector.sharedSecretFingerprint,
    );
    // Accept-on-read: legacy header names parse so admins can still repair via replace.
    const credential = connectorSharedCredentialReadSchema.parse(secret.value);
    const headers = sharedCredentialHeaders(credential);
    // Canonical collector treats dynamic header *keys* and values as secret leaves.
    return {
      headers,
      taintedValues: [
        ...collectConnectorSecretLeaves(credential),
        ...collectConnectorSecretLeaves({ headers }),
        ...Object.values(headers),
      ],
    };
  };

  private cancelJournal = async (token: ConnectorRuntimeJournalToken): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.dependencies.journal.cancel(token);
        return;
      } catch (error) {
        if (attempt === 2) {
          console.error('[connector-runtime] reserved journal cleanup deferred', {
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      }
    }
    // Preserve the stable business rejection. A best-effort retry can converge
    // immediately; the audit worker also deletes expired `reserved` rows.
    void this.dependencies.journal.cancel(token).catch((error) => {
      console.error('[connector-runtime] deferred reserved journal cleanup pending', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    });
  };

  private completeJournal = async (
    token: ConnectorRuntimeJournalToken,
    result: PlatformConnectorRuntimeResult,
  ): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.dependencies.journal.complete(token, result);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  private deliverJournalAudit = async (token: ConnectorRuntimeJournalToken): Promise<void> => {
    await this.dependencies.journal.deliverAudit(token, (record) =>
      this.dependencies.audit.appendSharedCall(record),
    );
  };

  private auditShared = async (
    invocation: PlatformConnectorRuntimeInvocation,
    connectorId: string,
    outcome: 'admitted' | 'allowed' | 'denied' | 'failed' | 'rate_limited',
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
    // Effective binding identity: the governance-designated shared auth owner
    // when set, else the invoking user. The ownership guard below MUST keep
    // comparing against this identity (not be removed) so a genuine mismatch —
    // a binding belonging to a third identity — still fails closed.
    const bindingUserId = invocation.effectiveBindingUserId ?? invocation.userId;
    const binding = await this.dependencies.bindingLoader(bindingUserId, connectorId);
    if (
      !binding ||
      binding.userId !== bindingUserId ||
      binding.connectorId !== connectorId ||
      binding.publishedRevision === null ||
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

  private reloadExactBinding = async (
    invocation: PlatformConnectorRuntimeInvocation,
    expected: PlatformUserConnectorBindingItem,
    allowedScopes: string[],
  ): Promise<PlatformUserConnectorBindingItem> => {
    if (expected.publishedRevision === null) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
    }
    const current = await this.loadBinding(
      invocation,
      expected.connectorId,
      expected.publishedRevision,
      allowedScopes,
    );
    if (
      current.id !== expected.id ||
      current.revision !== expected.revision ||
      current.status !== expected.status ||
      current.oauthTokenRef !== expected.oauthTokenRef ||
      current.tokenFingerprint !== expected.tokenFingerprint ||
      current.revokedAt?.getTime() !== expected.revokedAt?.getTime()
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
    }
    return current;
  };
}

const shouldAuditSharedFailure = (
  connector: { credentialMode: string },
  outboundStarted: boolean,
  journalToken: ConnectorRuntimeJournalToken | undefined,
  error: unknown,
): boolean =>
  connector.credentialMode === 'shared_service_account' &&
  !(outboundStarted && journalToken) &&
  !(
    error instanceof PlatformConnectorContractError &&
    (error.code === 'PLATFORM_CONNECTOR_RATE_LIMITED' ||
      error.code === 'PLATFORM_CONNECTOR_NOT_PUBLISHED' ||
      error.code === 'PLATFORM_CONNECTOR_RESOURCE_MISMATCH')
  );

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
  credential: z.infer<typeof connectorSharedCredentialReadSchema>,
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

const redactTaintedString = (value: string, taintedValues: string[]): string => {
  let redacted = value;
  for (const taint of new Set(taintedValues.filter(Boolean))) {
    const variants = new Set([
      taint,
      encodeURIComponent(taint),
      Buffer.from(taint).toString('base64'),
      Buffer.from(taint).toString('base64url'),
    ]);
    for (const variant of variants) redacted = redacted.split(variant).join('[REDACTED]');
  }
  return redacted;
};

const redactTaintedDeep = (value: unknown, taintedValues: string[]): unknown => {
  if (typeof value === 'string') return redactTaintedString(value, taintedValues);
  if (Array.isArray(value)) return value.map((item) => redactTaintedDeep(item, taintedValues));
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      redactTaintedString(key, taintedValues),
      redactTaintedDeep(child, taintedValues),
    ]),
  );
};

const parseRuntimeResponse = (
  body: unknown,
  taintedValues: string[],
): { content: string; state?: Record<string, unknown> } => {
  if (!isPlainRecord(body) || 'error' in body) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
  }
  const value = 'result' in body ? body.result : body;
  const redacted = redactDeep(redactTaintedDeep(value, taintedValues));
  const content = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  return {
    content,
    ...(isPlainRecord(redacted) ? { state: redacted } : {}),
  };
};

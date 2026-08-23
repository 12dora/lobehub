import { z } from 'zod';

import type { PlatformUserConnectorBindingItem } from '@/database/schemas/platform/connectors';

import {
  collectConnectorSecretLeaves,
  connectorSharedCredentialReadSchema,
} from '../../contracts/platformConnectors';
import { resolveConnectorSecretVersion } from './catalogSnapshot';
import { PlatformConnectorContractError } from './errors';
import type {
  PlatformConnectorRuntimeAdapterDependencies,
  PlatformConnectorRuntimeInvocation,
} from './runtimeAdapterTypes';
import { sharedCredentialHeaders } from './runtimeResponse';
import { assertConnectorScopesAllowed } from './toolPolicy';

const storedOAuthTokenSchema = z
  .object({
    accessToken: z.string().min(1).max(32_768),
    refreshToken: z.string().min(1).max(32_768).optional(),
  })
  .strict();

const DEFAULT_REFRESH_WINDOW_MS = 60_000;

export const loadConnectorBinding = async (
  dependencies: PlatformConnectorRuntimeAdapterDependencies,
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
  const binding = await dependencies.bindingLoader(bindingUserId, connectorId);
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

export const reloadExactConnectorBinding = async (
  dependencies: PlatformConnectorRuntimeAdapterDependencies,
  invocation: PlatformConnectorRuntimeInvocation,
  expected: PlatformUserConnectorBindingItem,
  allowedScopes: string[],
): Promise<PlatformUserConnectorBindingItem> => {
  if (expected.publishedRevision === null) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
  }
  const current = await loadConnectorBinding(
    dependencies,
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

export const resolveOAuthCredentials = async (
  dependencies: PlatformConnectorRuntimeAdapterDependencies,
  invocation: PlatformConnectorRuntimeInvocation,
  connector: {
    id: string;
    endpoint: string;
    oauthConfig: { scopes?: string[] } | null;
  },
  publishedRevision: number,
): Promise<{ headers: Record<string, string>; taintedValues: string[] }> => {
  const allowedScopes = connector.oauthConfig?.scopes ?? [];
  let binding = await loadConnectorBinding(
    dependencies,
    invocation,
    connector.id,
    publishedRevision,
    allowedScopes,
  );
  await dependencies.outbound.preflight(connector.endpoint);
  binding = await reloadExactConnectorBinding(dependencies, invocation, binding, allowedScopes);
  const now = (dependencies.clock ?? (() => new Date()))();
  const tokenExpiresAt = binding.expiresAt;
  if (
    tokenExpiresAt &&
    tokenExpiresAt.getTime() - now.getTime() <= DEFAULT_REFRESH_WINDOW_MS &&
    dependencies.refreshBinding
  ) {
    // Refresh runs under the effective binding identity: the shared
    // auth owner while governance designates one, else the invoking user.
    await dependencies.refreshBinding(
      invocation.effectiveBindingUserId ?? invocation.userId,
      connector.id,
      publishedRevision,
    );
    binding = await loadConnectorBinding(
      dependencies,
      invocation,
      connector.id,
      publishedRevision,
      allowedScopes,
    );
  }
  if (binding.expiresAt && binding.expiresAt <= now) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_BINDING_NOT_FOUND');
  }
  const tokenSecret = await dependencies.secrets.resolveSecretRef({
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
  await reloadExactConnectorBinding(dependencies, invocation, binding, allowedScopes);
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

export const resolveSharedCredentials = async (
  dependencies: PlatformConnectorRuntimeAdapterDependencies,
  invocation: PlatformConnectorRuntimeInvocation,
  connector: {
    endpoint: string;
    id: string;
    sharedSecretFingerprint: string | null;
  },
  auditShared: (
    invocation: PlatformConnectorRuntimeInvocation,
    connectorId: string,
    outcome: 'admitted' | 'rate_limited',
  ) => Promise<void>,
): Promise<{ headers: Record<string, string>; taintedValues: string[] }> => {
  const allowed = await dependencies.rateLimiter.consume(`${connector.id}:${invocation.userId}`);
  if (!allowed) {
    await auditShared(invocation, connector.id, 'rate_limited');
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RATE_LIMITED');
  }
  await auditShared(invocation, connector.id, 'admitted');
  await dependencies.outbound.preflight(connector.endpoint);
  const secret = await resolveConnectorSecretVersion(
    dependencies.secrets,
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

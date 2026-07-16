import { describe, expect, it, vi } from 'vitest';

import type { PlatformConnectorRevisionPayload } from '@/database/repositories/platformConnectorCatalog';
import type { PlatformUserConnectorBindingItem } from '@/database/schemas/platform/connectors';

import type { ConnectorCatalogSecretStore } from './catalogTypes';
import { PlatformConnectorContractError } from './errors';
import type { FrozenConnectorOperationSnapshot } from './operationSnapshot';
import {
  BoundedConnectorRuntimeRateLimiter,
  PlatformConnectorRuntimeAdapter,
  type PlatformConnectorRuntimeAdapterDependencies,
} from './runtimeAdapter';

const proof = {
  connectorId: 'connector-1',
  connectorKey: 'catalog',
  operationId: 'operation-1',
  publishedChecksum: 'a'.repeat(64),
  publishedRevision: 4,
  toolPolicyFingerprint: 'b'.repeat(64),
};

const tool = {
  description: null,
  displayName: 'Search',
  inputSchema: { type: 'object' },
  outputSchema: {},
  platformPolicy: 'allow' as const,
  requiresConfirmation: false,
  riskLevel: 'low' as const,
  sort: 0,
  toolKey: 'search',
};

const snapshot = (
  credentialMode: PlatformConnectorRevisionPayload['connector']['credentialMode'],
): FrozenConnectorOperationSnapshot => ({
  payload: {
    connector: {
      credentialMode,
      description: null,
      displayName: 'Catalog',
      enabled: true,
      endpoint: 'https://connector.example.test/mcp',
      id: 'connector-1',
      key: 'catalog',
      oauthClientSecretConfigured: false,
      oauthClientSecretFingerprint: null,
      oauthConfig:
        credentialMode === 'per_user_oauth'
          ? {
              authorizationEndpoint: 'https://identity.example.test/authorize',
              clientId: 'client',
              issuer: 'https://identity.example.test',
              redirectUri: 'https://aihub.example.test/oauth/connector/callback',
              scopes: ['read'],
              tokenEndpoint: 'https://identity.example.test/token',
            }
          : null,
      sharedSecretConfigured: credentialMode === 'shared_service_account',
      sharedSecretFingerprint: credentialMode === 'shared_service_account' ? 'c'.repeat(64) : null,
      sort: 0,
      transport: 'http',
    },
    schemaVersion: 'm09-v1',
    tools: [tool],
  },
  proof,
  publishedAt: new Date('2026-07-17T00:00:00Z'),
});

const binding = (overrides: Partial<PlatformUserConnectorBindingItem> = {}) =>
  ({
    connectedAt: new Date('2026-07-17T00:00:00Z'),
    connectorId: 'connector-1',
    createdAt: new Date('2026-07-17T00:00:00Z'),
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    id: 'binding-1',
    lastErrorCategory: null,
    oauthTokenRef: 'kms://platform-connectors/connector-1/oauthBindingToken/token',
    publishedRevision: 4,
    revision: 1,
    revisionResourceType: 'connector',
    revokedAt: null,
    scopes: ['read'],
    status: 'connected',
    tokenFingerprint: 'd'.repeat(64),
    updatedAt: new Date('2026-07-17T00:00:00Z'),
    userId: 'user-1',
    ...overrides,
  }) satisfies PlatformUserConnectorBindingItem;

const invocation = {
  agentId: 'agent-1',
  arguments: '{"query":"docs"}',
  humanApproved: true,
  proof,
  toolKey: 'search',
  userId: 'user-1',
};

const createHarness = (
  credentialMode: PlatformConnectorRevisionPayload['connector']['credentialMode'],
) => {
  const order: string[] = [];
  const resolveSecretVersion = vi.fn(async () => {
    order.push('secret-version');
    return {
      fingerprint: 'c'.repeat(64),
      ref: 'kms://platform-connectors/connector-1/sharedSecret/secret',
      updatedAt: new Date(),
      value: { bearerToken: 'shared-token' },
    };
  });
  const resolveSecretRef = vi.fn(async () => {
    order.push('secret-ref');
    return {
      fingerprint: 'd'.repeat(64),
      ref: 'kms://platform-connectors/connector-1/oauthBindingToken/token',
      updatedAt: new Date(),
      value: { accessToken: 'user-token', refreshToken: 'refresh-token' },
    };
  });
  const secrets = {
    loadCurrentSecretSources: vi.fn(),
    persistSecret: vi.fn(),
    resolveSecretRef,
    resolveSecretVersion,
    revokeSecretRef: vi.fn(),
  } as unknown as ConnectorCatalogSecretStore;
  const dependencies: PlatformConnectorRuntimeAdapterDependencies = {
    audit: { appendSharedCall: vi.fn(async () => {}) },
    bindingLoader: vi.fn(async () => binding()),
    clock: () => new Date('2029-01-01T00:00:00Z'),
    outbound: {
      preflight: vi.fn(async () => {
        order.push('preflight');
        return { policyVersion: 1 };
      }),
      requestJson: vi.fn(async () => {
        order.push('outbound');
        return {
          body: { jsonrpc: '2.0', result: { accessToken: 'must-redact', value: 'ok' } },
          status: 200,
          url: 'https://connector.example.test/mcp',
        };
      }),
    },
    policy: {
      resolve: vi.fn(async () => {
        order.push('policy');
        return { agentAllowed: true, userEnabled: true };
      }),
    },
    rateLimiter: { consume: vi.fn(async () => true) },
    refreshBinding: vi.fn(async () => {}),
    secrets,
    snapshots: { resolveExact: vi.fn(async () => snapshot(credentialMode)) },
  };
  return {
    adapter: new PlatformConnectorRuntimeAdapter(dependencies),
    dependencies,
    order,
    resolveSecretRef,
    resolveSecretVersion,
  };
};

describe('PlatformConnectorRuntimeAdapter', () => {
  it('enforces deny precedence, allow intersection, user disable, unknown tools, and confirmation', async () => {
    const harness = createHarness('none');
    vi.mocked(harness.dependencies.policy.resolve)
      .mockResolvedValueOnce({ agentAllowed: false, userEnabled: true })
      .mockResolvedValueOnce({ agentAllowed: true, userEnabled: false });
    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_TOOL_DENIED',
    );
    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_TOOL_DENIED',
    );
    await expect(harness.adapter.execute({ ...invocation, toolKey: 'unknown' })).rejects.toThrow(
      'PLATFORM_CONNECTOR_TOOL_DENIED',
    );

    vi.mocked(harness.dependencies.snapshots.resolveExact).mockResolvedValueOnce({
      ...snapshot('none'),
      payload: {
        ...snapshot('none').payload,
        tools: [{ ...tool, requiresConfirmation: true, riskLevel: 'critical' }],
      },
    });
    await expect(harness.adapter.execute({ ...invocation, humanApproved: false })).rejects.toThrow(
      'PLATFORM_CONNECTOR_CONFIRMATION_REQUIRED',
    );
    expect(harness.dependencies.outbound.preflight).not.toHaveBeenCalled();
    expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
  });

  it('preflights before a shared secret, audits caller identity, rate limits, and redacts output', async () => {
    const harness = createHarness('shared_service_account');
    await expect(harness.adapter.execute(invocation)).resolves.toEqual({
      confirmation: null,
      content: JSON.stringify({ accessToken: '[REDACTED]', value: 'ok' }),
      state: { accessToken: '[REDACTED]', value: 'ok' },
      success: true,
    });
    expect(harness.order).toEqual(['policy', 'preflight', 'secret-version', 'outbound']);
    expect(harness.dependencies.audit.appendSharedCall).toHaveBeenCalledWith({
      connectorId: 'connector-1',
      operationId: 'operation-1',
      outcome: 'allowed',
      toolKey: 'search',
      userId: 'user-1',
    });
    expect(harness.resolveSecretVersion).toHaveBeenCalledWith({
      connectorId: 'connector-1',
      fingerprint: 'c'.repeat(64),
      slot: 'sharedSecret',
    });

    vi.mocked(harness.dependencies.rateLimiter.consume).mockResolvedValueOnce(false);
    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_RATE_LIMITED',
    );
    expect(harness.resolveSecretVersion).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.outbound.requestJson).toHaveBeenCalledTimes(1);
  });

  it('binds OAuth to exact user/revision/status/scopes/expiry and token fingerprint', async () => {
    const harness = createHarness('per_user_oauth');
    await expect(harness.adapter.execute(invocation)).resolves.toMatchObject({ success: true });
    expect(harness.order).toEqual(['policy', 'preflight', 'secret-ref', 'outbound']);

    for (const invalid of [
      binding({ userId: 'user-2' }),
      binding({ connectorId: 'connector-2' }),
      binding({ publishedRevision: 3 }),
      binding({ revokedAt: new Date(), status: 'revoked' }),
      binding({ scopes: ['write'] }),
    ]) {
      vi.mocked(harness.dependencies.bindingLoader).mockResolvedValueOnce(invalid);
      await expect(harness.adapter.execute(invocation)).rejects.toThrow();
    }
    vi.mocked(harness.dependencies.bindingLoader).mockResolvedValueOnce(binding());
    harness.resolveSecretRef.mockResolvedValueOnce({
      fingerprint: 'e'.repeat(64),
      ref: binding().oauthTokenRef!,
      updatedAt: new Date(),
      value: { accessToken: 'wrong-version', refreshToken: 'refresh-token' },
    });
    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED',
    );
  });

  it('preserves an old still-valid token on refresh failure but never uses an expired one', async () => {
    const harness = createHarness('per_user_oauth');
    vi.mocked(harness.dependencies.bindingLoader).mockResolvedValue(
      binding({ expiresAt: new Date('2029-01-01T00:00:30Z') }),
    );
    vi.mocked(harness.dependencies.refreshBinding!).mockRejectedValueOnce(
      new Error('refresh race'),
    );
    await expect(harness.adapter.execute(invocation)).resolves.toMatchObject({ success: true });

    vi.mocked(harness.dependencies.bindingLoader).mockResolvedValue(
      binding({ expiresAt: new Date('2028-12-31T23:59:59Z') }),
    );
    vi.mocked(harness.dependencies.refreshBinding!).mockRejectedValueOnce(
      new Error('refresh down'),
    );
    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED',
    );
    expect(harness.dependencies.outbound.requestJson).toHaveBeenCalledTimes(1);
  });

  it('never touches secrets or runtime outbound when SSRF preflight fails', async () => {
    const harness = createHarness('shared_service_account');
    vi.mocked(harness.dependencies.outbound.preflight).mockRejectedValueOnce(
      new PlatformConnectorContractError('PLATFORM_CONNECTOR_SSRF_BLOCKED'),
    );
    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_SSRF_BLOCKED',
    );
    expect(harness.resolveSecretVersion).not.toHaveBeenCalled();
    expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
  });
});

describe('BoundedConnectorRuntimeRateLimiter', () => {
  it('bounds requests per window and evicts scopes without growing unbounded', () => {
    let now = 1_000;
    const limiter = new BoundedConnectorRuntimeRateLimiter({
      clock: () => now,
      maxEntries: 2,
      maxRequests: 2,
      windowMs: 100,
    });
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(false);
    expect(limiter.consume('b')).toBe(true);
    expect(limiter.consume('c')).toBe(true);
    expect(limiter.consume('a')).toBe(true);
    now += 101;
    expect(limiter.consume('a')).toBe(true);
  });
});

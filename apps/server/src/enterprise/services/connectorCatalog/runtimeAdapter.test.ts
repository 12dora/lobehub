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
    legacyAuthStatus: 'connected',
    legacyEncryptedCredentials: null,
    legacyLastError: null,
    legacyStatus: 'active',
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
  toolCallId: 'tool-call-1',
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
    journal: {
      arm: vi.fn(async () => {}),
      begin: vi.fn(async () => ({
        status: 'acquired' as const,
        token: { jobId: 'journal-1', owner: 'owner-1' },
      })),
      cancel: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
      deliverAudit: vi.fn(async (_token, delivery) => {
        await delivery({
          connectorId: 'connector-1',
          idempotencyKey: 'connector-runtime-audit:journal-1',
          operationId: 'operation-1',
          outcome: 'allowed',
          toolKey: 'search',
          userId: 'user-1',
        });
        return true;
      }),
    },
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
    vi.mocked(harness.dependencies.outbound.requestJson).mockResolvedValueOnce({
      body: {
        result: {
          arbitrary: `prefix shared-token ${Buffer.from('shared-token').toString('base64')} suffix`,
          value: 'ok',
        },
      },
      status: 200,
      url: 'https://connector.example.test/mcp',
    });
    await expect(harness.adapter.execute(invocation)).resolves.toEqual({
      confirmation: null,
      content: JSON.stringify({
        arbitrary: 'prefix [REDACTED] [REDACTED] suffix',
        value: 'ok',
      }),
      state: { arbitrary: 'prefix [REDACTED] [REDACTED] suffix', value: 'ok' },
      success: true,
    });
    expect(harness.order).toEqual(['policy', 'preflight', 'secret-version']);
    expect(harness.dependencies.audit.appendSharedCall).toHaveBeenCalledWith({
      connectorId: 'connector-1',
      idempotencyKey: 'connector-runtime-audit:journal-1',
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
    expect(harness.dependencies.audit.appendSharedCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'admitted' }),
    );

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

  it('scrubs OAuth access and refresh tokens from arbitrary response keys and encodings', async () => {
    const harness = createHarness('per_user_oauth');
    vi.mocked(harness.dependencies.outbound.requestJson).mockResolvedValueOnce({
      body: {
        result: {
          [`key-${encodeURIComponent('user-token')}`]:
            Buffer.from('refresh-token').toString('base64url'),
          nested: ['prefix user-token suffix'],
        },
      },
      status: 200,
      url: 'https://connector.example.test/mcp',
    });

    const result = await harness.adapter.execute(invocation);

    expect(result.content).not.toContain('user-token');
    expect(result.content).not.toContain('refresh-token');
    expect(result.content).not.toContain(Buffer.from('refresh-token').toString('base64url'));
    expect(result.state).toEqual({
      'key-[REDACTED]': '[REDACTED]',
      'nested': ['prefix [REDACTED] suffix'],
    });
  });

  it('fails closed on refresh failure even when the old token has not expired', async () => {
    const harness = createHarness('per_user_oauth');
    vi.mocked(harness.dependencies.bindingLoader).mockResolvedValue(
      binding({ expiresAt: new Date('2029-01-01T00:00:30Z') }),
    );
    vi.mocked(harness.dependencies.refreshBinding!).mockRejectedValueOnce(
      new Error('refresh race'),
    );
    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED',
    );

    vi.mocked(harness.dependencies.bindingLoader).mockResolvedValue(
      binding({ expiresAt: new Date('2028-12-31T23:59:59Z') }),
    );
    vi.mocked(harness.dependencies.refreshBinding!).mockRejectedValueOnce(
      new Error('refresh down'),
    );
    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED',
    );
    expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
  });

  it('refreshes against the exact published revision frozen in the operation proof', async () => {
    const harness = createHarness('per_user_oauth');
    vi.mocked(harness.dependencies.bindingLoader).mockResolvedValue(
      binding({ expiresAt: new Date('2029-01-01T00:00:30Z') }),
    );

    await expect(harness.adapter.execute(invocation)).resolves.toMatchObject({ success: true });

    expect(harness.dependencies.refreshBinding).toHaveBeenCalledWith(
      'user-1',
      'connector-1',
      proof.publishedRevision,
    );
  });

  it('fails closed when a binding is revoked after preflight or token resolution', async () => {
    const afterPreflight = createHarness('per_user_oauth');
    vi.mocked(afterPreflight.dependencies.bindingLoader)
      .mockResolvedValueOnce(binding())
      .mockResolvedValueOnce(binding({ revokedAt: new Date(), status: 'revoked' }));
    await expect(afterPreflight.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH',
    );
    expect(afterPreflight.resolveSecretRef).not.toHaveBeenCalled();
    expect(afterPreflight.dependencies.outbound.requestJson).not.toHaveBeenCalled();

    const afterSecret = createHarness('per_user_oauth');
    vi.mocked(afterSecret.dependencies.bindingLoader)
      .mockResolvedValueOnce(binding())
      .mockResolvedValueOnce(binding())
      .mockResolvedValueOnce(binding({ revision: 2 }));
    await expect(afterSecret.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH',
    );
    expect(afterSecret.dependencies.outbound.requestJson).not.toHaveBeenCalled();
  });

  it('does not resolve a shared secret or call outbound when admission audit fails', async () => {
    const harness = createHarness('shared_service_account');
    vi.mocked(harness.dependencies.audit.appendSharedCall).mockRejectedValue(
      new Error('audit unavailable'),
    );
    await expect(harness.adapter.execute(invocation)).rejects.toThrow();
    expect(harness.dependencies.outbound.preflight).not.toHaveBeenCalled();
    expect(harness.resolveSecretVersion).not.toHaveBeenCalled();
    expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
  });

  it('returns the journaled success when terminal audit delivery fails after outbound', async () => {
    const harness = createHarness('shared_service_account');
    vi.mocked(harness.dependencies.audit.appendSharedCall).mockImplementation(async (entry) => {
      if (entry.outcome === 'allowed') throw new Error('terminal audit unavailable');
    });

    await expect(harness.adapter.execute(invocation)).resolves.toMatchObject({ success: true });

    expect(harness.dependencies.outbound.requestJson).toHaveBeenCalledOnce();
    expect(harness.dependencies.journal.complete).toHaveBeenCalledOnce();
  });

  it('retries terminal journal persistence and fails closed without repeating outbound', async () => {
    const recovered = createHarness('shared_service_account');
    vi.mocked(recovered.dependencies.journal.complete)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce();

    await expect(recovered.adapter.execute(invocation)).resolves.toMatchObject({ success: true });
    expect(recovered.dependencies.journal.complete).toHaveBeenCalledTimes(3);
    expect(recovered.dependencies.outbound.requestJson).toHaveBeenCalledOnce();

    const failed = createHarness('shared_service_account');
    vi.mocked(failed.dependencies.journal.complete).mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(failed.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_RESOURCE_MISMATCH',
    );
    expect(failed.dependencies.journal.complete).toHaveBeenCalledTimes(3);
    expect(failed.dependencies.outbound.requestJson).toHaveBeenCalledOnce();
    expect(failed.dependencies.audit.appendSharedCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
    );
  });

  it('replays a completed shared call without repeating the external side effect', async () => {
    const harness = createHarness('shared_service_account');
    vi.mocked(harness.dependencies.journal.begin).mockResolvedValueOnce({
      auditPending: false,
      result: { confirmation: null, content: 'cached', success: true },
      status: 'replay',
      token: { jobId: 'journal-1', owner: 'owner-1' },
    });

    await expect(harness.adapter.execute(invocation)).resolves.toMatchObject({
      content: 'cached',
      success: true,
    });

    expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
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

  it('rechecks current publication before reserving a shared idempotency key', async () => {
    const harness = createHarness('shared_service_account');
    harness.dependencies.assertCurrentPublished = vi.fn(async () => {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    });

    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_NOT_PUBLISHED',
    );
    expect(harness.dependencies.journal.begin).not.toHaveBeenCalled();
    expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
    expect(harness.dependencies.audit.appendSharedCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
    );
  });

  it('cancels the journal when archive wins the post-reservation race', async () => {
    const harness = createHarness('shared_service_account');
    harness.dependencies.assertCurrentPublished = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(
        new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED'),
      );

    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_NOT_PUBLISHED',
    );
    expect(harness.dependencies.journal.begin).toHaveBeenCalledOnce();
    expect(harness.dependencies.journal.cancel).toHaveBeenCalledWith({
      jobId: 'journal-1',
      owner: 'owner-1',
    });
    expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
    expect(harness.dependencies.audit.appendSharedCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
    );
  });

  it('preserves archive rejection while failed cancellation converges asynchronously', async () => {
    const harness = createHarness('shared_service_account');
    harness.dependencies.assertCurrentPublished = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(
        new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED'),
      );
    vi.mocked(harness.dependencies.journal.cancel)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce();

    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_NOT_PUBLISHED',
    );
    expect(harness.dependencies.journal.arm).not.toHaveBeenCalled();
    expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
    expect(harness.dependencies.audit.appendSharedCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.stringMatching(/failed|unknown/) }),
    );
    await vi.waitFor(() => expect(harness.dependencies.journal.cancel).toHaveBeenCalledTimes(4));
  });

  it('loads and refreshes the shared owner binding when effectiveBindingUserId is set', async () => {
    // Org connector governance designates 'owner-1' as the shared auth
    // identity: the binding must be loaded (and refreshed) for the OWNER, not
    // the invoking user, and the ownership guard must accept the owner's
    // binding. Expiry within the refresh window forces the refresh path.
    const harness = createHarness('per_user_oauth');
    vi.mocked(harness.dependencies.bindingLoader).mockResolvedValue(
      binding({ expiresAt: new Date('2029-01-01T00:00:30Z'), userId: 'owner-1' }),
    );

    await expect(
      harness.adapter.execute({ ...invocation, effectiveBindingUserId: 'owner-1' }),
    ).resolves.toMatchObject({ success: true });

    expect(harness.dependencies.bindingLoader).toHaveBeenCalledWith('owner-1', 'connector-1');
    expect(harness.dependencies.bindingLoader).not.toHaveBeenCalledWith('user-1', 'connector-1');
    expect(harness.dependencies.refreshBinding).toHaveBeenCalledWith(
      'owner-1',
      'connector-1',
      proof.publishedRevision,
    );
  });

  it('still rejects bindings of a third identity under an effectiveBindingUserId', async () => {
    // The ownership guard compares against the EFFECTIVE identity — a binding
    // belonging to anyone else (a third user, or even the invoking user while
    // the org mandates the shared owner) must keep failing closed.
    for (const bindingUserId of ['intruder', 'user-1']) {
      const harness = createHarness('per_user_oauth');
      vi.mocked(harness.dependencies.bindingLoader).mockResolvedValue(
        binding({ userId: bindingUserId }),
      );
      await expect(
        harness.adapter.execute({ ...invocation, effectiveBindingUserId: 'owner-1' }),
      ).rejects.toThrow('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
      expect(harness.resolveSecretRef).not.toHaveBeenCalled();
      expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
    }
  });

  it('keeps the per-user binding path when no effectiveBindingUserId is provided', async () => {
    const harness = createHarness('per_user_oauth');

    await expect(harness.adapter.execute(invocation)).resolves.toMatchObject({ success: true });

    expect(harness.dependencies.bindingLoader).toHaveBeenCalledWith('user-1', 'connector-1');
  });

  it('fails closed without outbound when a slow publication check outlives the reservation', async () => {
    const harness = createHarness('shared_service_account');
    vi.mocked(harness.dependencies.journal.arm).mockRejectedValueOnce(
      new Error('Connector runtime journal arm conflict'),
    );

    await expect(harness.adapter.execute(invocation)).rejects.toThrow(
      'PLATFORM_CONNECTOR_RESOURCE_MISMATCH',
    );
    expect(harness.dependencies.journal.arm).toHaveBeenCalledOnce();
    expect(harness.dependencies.outbound.requestJson).not.toHaveBeenCalled();
    expect(harness.dependencies.audit.appendSharedCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.stringMatching(/failed|unknown/) }),
    );
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

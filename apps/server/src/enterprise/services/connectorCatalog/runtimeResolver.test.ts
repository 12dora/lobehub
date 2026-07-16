import { describe, expect, it } from 'vitest';

import { resolveConnectorRuntime } from './runtimeResolver';

const tool = {
  description: null,
  displayName: 'Search',
  enabled: true,
  id: 'tool-1',
  inputSchema: { type: 'object' },
  platformPolicy: 'allow' as const,
  requiresConfirmation: false,
  riskLevel: 'low' as const,
  sort: 0,
  toolKey: 'search',
};
const input = {
  connectorId: 'connector-1',
  expectedPublishedRevision: 4,
  toolKey: 'search',
  userId: 'user-1',
};
const policy = {
  agentAllowed: true,
  connectorId: 'connector-1',
  publishedRevision: 4,
  toolKey: 'search',
  userEnabled: true,
  userId: 'user-1',
};
const catalogBase = {
  connectorId: 'connector-1',
  endpoint: 'https://mcp.example.test/v1',
  publishedRevision: 4,
  tools: [tool],
  transport: 'http' as const,
};

describe('resolveConnectorRuntime', () => {
  it('returns a discriminated no-credential resolution from the trusted Published revision', () => {
    expect(
      resolveConnectorRuntime({
        catalog: { ...catalogBase, credentialMode: 'none' },
        input,
        policy,
      }),
    ).toMatchObject({
      connectorId: 'connector-1',
      credentialMode: 'none',
      publishedRevision: 4,
      tool: { toolKey: 'search' },
    });
  });

  it('returns server-only shared credentials only for the shared mode', () => {
    expect(
      resolveConnectorRuntime({
        catalog: {
          ...catalogBase,
          credentialMode: 'shared_service_account',
          credentials: { apiKey: 'fake-shared-key' },
        },
        input,
        policy,
      }),
    ).toMatchObject({
      credentialMode: 'shared_service_account',
      credentials: { apiKey: 'fake-shared-key' },
    });
  });

  it('binds per-user OAuth to user, connector, and Published revision', () => {
    const binding = {
      accessToken: 'fake-access-token',
      bindingId: 'binding-1',
      connectorId: 'connector-1',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      publishedRevision: 4,
      scopes: ['issues:read'],
      status: 'connected' as const,
      userId: 'user-1',
    };
    expect(
      resolveConnectorRuntime({
        binding,
        catalog: {
          ...catalogBase,
          allowedScopes: ['issues:read'],
          credentialMode: 'per_user_oauth',
        },
        input,
        now: new Date('2029-01-01T00:00:00Z'),
        policy,
      }),
    ).toMatchObject({ bindingId: 'binding-1', credentialMode: 'per_user_oauth', userId: 'user-1' });

    for (const staleBinding of [
      { ...binding, connectorId: 'other-connector' },
      { ...binding, publishedRevision: 3 },
      { ...binding, userId: 'other-user' },
      { ...binding, expiresAt: new Date('2028-01-01T00:00:00Z') },
    ]) {
      expect(() =>
        resolveConnectorRuntime({
          binding: staleBinding,
          catalog: {
            ...catalogBase,
            allowedScopes: ['issues:read'],
            credentialMode: 'per_user_oauth',
          },
          input,
          now: new Date('2029-01-01T00:00:00Z'),
          policy,
        }),
      ).toThrowError('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
    }
  });

  it('denies unknown, disabled, stale, and policy-denied tools', () => {
    const cases = [
      {
        catalog: { ...catalogBase, credentialMode: 'none' as const },
        input: { ...input, toolKey: 'unknown' },
      },
      {
        catalog: {
          ...catalogBase,
          credentialMode: 'none' as const,
          tools: [{ ...tool, enabled: false }],
        },
        input,
      },
      {
        catalog: { ...catalogBase, credentialMode: 'none' as const },
        input: { ...input, expectedPublishedRevision: 3 },
      },
      {
        catalog: {
          ...catalogBase,
          credentialMode: 'none' as const,
          tools: [{ ...tool, platformPolicy: 'deny' as const }],
        },
        input,
      },
    ];
    for (const item of cases) expect(() => resolveConnectorRuntime({ ...item, policy })).toThrow();
  });

  it('rejects untrusted policy booleans, forged trusted policy identity, and scope expansion', () => {
    expect(() =>
      resolveConnectorRuntime({
        catalog: { ...catalogBase, credentialMode: 'none' },
        input: { ...input, agentAllowed: true } as never,
        policy,
      }),
    ).toThrow();
    for (const forgedPolicy of [
      { ...policy, connectorId: 'other-connector' },
      { ...policy, publishedRevision: 3 },
      { ...policy, toolKey: 'other-tool' },
      { ...policy, userId: 'other-user' },
    ]) {
      expect(() =>
        resolveConnectorRuntime({
          catalog: { ...catalogBase, credentialMode: 'none' },
          input,
          policy: forgedPolicy,
        }),
      ).toThrowError('PLATFORM_CONNECTOR_TOOL_DENIED');
    }
    expect(() =>
      resolveConnectorRuntime({
        binding: {
          accessToken: 'fake-access-token',
          bindingId: 'binding-1',
          connectorId: 'connector-1',
          expiresAt: null,
          publishedRevision: 4,
          scopes: ['issues:write'],
          status: 'connected',
          userId: 'user-1',
        },
        catalog: {
          ...catalogBase,
          allowedScopes: ['issues:read'],
          credentialMode: 'per_user_oauth',
        },
        input,
        policy,
      }),
    ).toThrowError('PLATFORM_CONNECTOR_SCOPE_NOT_ALLOWED');
  });
});

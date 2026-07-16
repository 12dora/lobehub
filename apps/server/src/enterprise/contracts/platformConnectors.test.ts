import { describe, expect, it } from 'vitest';

import {
  adminConnectorCreateDraftInputSchema,
  adminConnectorDraftSchema,
  connectorOAuthCallbackInputSchema,
  connectorOAuthClientSecretMutationSchema,
  connectorOAuthStatePayloadSchema,
  connectorReturnToSchema,
  connectorScopesSchema,
  connectorSharedSecretMutationSchema,
  managedConnectorSchema,
  userConnectorStartAuthorizationInputSchema,
  webConnectorTransportSchema,
} from './platformConnectors';

const secretState = { configured: false, fingerprint: null, updatedAt: null };
const draft = {
  connectionTest: null,
  credentialMode: 'per_user_oauth',
  description: 'Issue tracker',
  displayName: 'Issues',
  enabled: true,
  endpoint: 'https://mcp.example.test/v1',
  id: 'connector-1',
  key: 'issues',
  oauthClientSecret: secretState,
  oauthConfig: {
    authorizationEndpoint: 'https://identity.example.test/authorize',
    clientId: 'client-id',
    issuer: 'https://identity.example.test',
    redirectUri: 'https://aihub.example.test/oauth/connector/callback',
    scopes: ['issues:read'],
    tokenEndpoint: 'https://identity.example.test/token',
  },
  revision: 0,
  sharedSecret: secretState,
  sort: 0,
  status: 'draft',
  tools: [],
  transport: 'http',
} as const;

describe('platform connector contracts', () => {
  it('models independent shared and OAuth client secret mutations', () => {
    expect(connectorSharedSecretMutationSchema.parse({ operation: 'keep' })).toEqual({
      operation: 'keep',
    });
    expect(
      connectorSharedSecretMutationSchema.parse({
        operation: 'replace',
        value: { headers: { Authorization: 'Bearer fake-token' } },
      }),
    ).toEqual({
      operation: 'replace',
      value: { headers: { Authorization: 'Bearer fake-token' } },
    });
    expect(connectorSharedSecretMutationSchema.parse({ operation: 'clear' })).toEqual({
      operation: 'clear',
    });
    expect(
      connectorOAuthClientSecretMutationSchema.parse({ operation: 'replace', value: 'fake' }),
    ).toEqual({ operation: 'replace', value: 'fake' });
    expect(
      connectorOAuthClientSecretMutationSchema.safeParse({
        operation: 'keep',
        value: 'smuggled',
      }).success,
    ).toBe(false);
  });

  it('accepts only HTTP transport in the web contract and fails stdio closed', () => {
    expect(webConnectorTransportSchema.parse('http')).toBe('http');
    expect(webConnectorTransportSchema.safeParse('stdio').success).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        credentialMode: 'none',
        displayName: 'Unsafe',
        endpoint: 'https://example.test',
        key: 'unsafe',
        reason: 'create',
        transport: 'stdio',
      }).success,
    ).toBe(false);
  });

  it('keeps credential modes mutually exclusive', () => {
    const base = {
      displayName: 'Connector',
      endpoint: 'https://example.test',
      key: 'connector',
      reason: 'create',
      transport: 'http',
    };
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        credentialMode: 'none',
        sharedSecret: { operation: 'clear' },
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        credentialMode: 'shared_service_account',
        oauthClientSecret: { operation: 'keep' },
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        credentialMode: 'per_user_oauth',
        sharedSecret: { operation: 'replace', value: { apiKey: 'fake' } },
      }).success,
    ).toBe(false);
  });

  it('rejects credential-bearing endpoints, sensitive JSON, and secret-bearing reason text', () => {
    const base = {
      credentialMode: 'none',
      displayName: 'Connector',
      key: 'connector',
      reason: 'create',
      transport: 'http',
    };
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        endpoint: 'https://user:password@example.test',
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        endpoint: 'https://example.test?access_token=fake',
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        endpoint: 'https://example.test',
        reason: 'Authorization: Bearer fake-token-value',
      }).success,
    ).toBe(false);
    expect(
      adminConnectorCreateDraftInputSchema.safeParse({
        ...base,
        endpoint: 'file:///etc/passwd',
      }).success,
    ).toBe(false);
  });

  it('returns only secret state in admin projections', () => {
    expect(adminConnectorDraftSchema.parse(draft)).toEqual(draft);
    expect(
      adminConnectorDraftSchema.safeParse({ ...draft, encryptedSharedSecret: 'ciphertext' })
        .success,
    ).toBe(false);
    expect(
      adminConnectorDraftSchema.safeParse({
        ...draft,
        oauthClientSecret: { ...secretState, value: 'plaintext' },
      }).success,
    ).toBe(false);
  });

  it('never exposes endpoint, OAuth client, or secret metadata to ordinary users', () => {
    const managed = {
      binding: null,
      credentialMode: 'per_user_oauth',
      description: 'Issue tracker',
      displayName: 'Issues',
      id: 'connector-1',
      key: 'issues',
      publishedRevision: 4,
      tools: [],
    };
    expect(managedConnectorSchema.parse(managed)).toEqual(managed);
    for (const leaked of [
      { endpoint: 'https://mcp.example.test' },
      { oauthConfig: draft.oauthConfig },
      { oauthClientSecret: secretState },
      { sharedSecret: secretState },
      { transport: 'http' },
    ]) {
      expect(managedConnectorSchema.safeParse({ ...managed, ...leaked }).success).toBe(false);
    }
  });

  it('binds callback authority exclusively to server-side state', () => {
    const now = Date.now();
    const state = {
      bindingId: 'binding-1',
      codeChallengeMethod: 'S256',
      codeVerifier: 'a'.repeat(43),
      connectorId: 'connector-1',
      expiresAt: now + 600_000,
      issuedAt: now,
      publishedRevision: 7,
      redirectUri: 'https://aihub.example.test/oauth/connector/callback',
      returnTo: '/settings/connectors?connected=1',
      scopes: ['issues:read'],
      userId: 'user-1',
    };
    expect(connectorOAuthStatePayloadSchema.parse(state)).toEqual(state);
    expect(
      connectorOAuthCallbackInputSchema.parse({ code: 'code', state: 's'.repeat(32) }),
    ).toEqual({
      code: 'code',
      state: 's'.repeat(32),
    });
    expect(
      connectorOAuthCallbackInputSchema.safeParse({
        code: 'code',
        connectorId: 'attacker-selected',
        state: 's'.repeat(32),
      }).success,
    ).toBe(false);
    expect(
      connectorOAuthStatePayloadSchema.safeParse({ ...state, expiresAt: now - 1 }).success,
    ).toBe(false);
  });

  it('accepts only site-relative returnTo paths and an allowlisted scope set', () => {
    for (const valid of ['/settings/connectors', '/settings/connectors?status=ok#binding']) {
      expect(connectorReturnToSchema.parse(valid)).toBe(valid);
      expect(
        userConnectorStartAuthorizationInputSchema.safeParse({
          connectorId: 'connector-1',
          returnTo: valid,
        }).success,
      ).toBe(true);
    }
    for (const invalid of [
      'https://evil.example',
      '//evil.example/path',
      '/%2f%2fevil.example/path',
      '/%255c%255cevil.example/path',
      '/%25252525252525252525252f%25252525252525252525252fevil.example/path',
      '/\\evil.example',
    ]) {
      expect(connectorReturnToSchema.safeParse(invalid).success).toBe(false);
    }
    expect(connectorScopesSchema.parse(['openid', 'issues:read'])).toEqual([
      'openid',
      'issues:read',
    ]);
    expect(connectorScopesSchema.safeParse(['openid', 'openid']).success).toBe(false);
    expect(connectorScopesSchema.safeParse(['openid profile']).success).toBe(false);
  });
});

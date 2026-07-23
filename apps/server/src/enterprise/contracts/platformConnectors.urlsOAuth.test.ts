import { describe, expect, it } from 'vitest';

import {
  adminConnectorCreateDraftInputSchema,
  connectorOAuthCallbackInputSchema,
  connectorOAuthStatePayloadSchema,
  connectorReturnToSchema,
  connectorScopesSchema,
  userConnectorGetAuthorizationStatusInputSchema,
  userConnectorGetAuthorizationStatusOutputSchema,
  userConnectorStartAuthorizationInputSchema,
  userConnectorStartAuthorizationOutputSchema,
  webConnectorTransportSchema,
} from './platformConnectors';

describe('platform connector contracts — urls/oauth', () => {
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
      stateHash: 'a'.repeat(64),
      stateId: 'b'.repeat(32),
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
      '/settings%0d%0aLocation:%20https://evil.example',
      '/settings%00/connectors',
      '/settings%7f/connectors',
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
  it('requires one opaque attempt id across authorization start and status polling', () => {
    const attemptId = 'a'.repeat(32);
    expect(
      userConnectorStartAuthorizationOutputSchema.parse({
        attemptId,
        authorizationUrl: 'https://identity.example.test/authorize',
        bindingId: 'binding-1',
      }),
    ).toMatchObject({ attemptId });
    expect(
      userConnectorGetAuthorizationStatusInputSchema.safeParse({ connectorId: 'connector-1' })
        .success,
    ).toBe(false);
    expect(
      userConnectorGetAuthorizationStatusInputSchema.safeParse({
        attemptId: 'not-opaque',
        connectorId: 'connector-1',
      }).success,
    ).toBe(false);
    expect(
      userConnectorGetAuthorizationStatusOutputSchema.parse({
        attemptId,
        binding: null,
        status: 'pending',
      }),
    ).toEqual({ attemptId, binding: null, status: 'pending' });
    expect(
      userConnectorGetAuthorizationStatusOutputSchema.safeParse({
        attemptId,
        binding: { status: 'connected' },
        status: 'pending',
      }).success,
    ).toBe(false);
  });
});

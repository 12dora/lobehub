// @vitest-environment node
import { createHash } from 'node:crypto';

import { DINGTALK_IDENTITY_PROVIDER_ISSUER } from '@lobechat/types';
import type { getOAuthState } from 'better-auth/api';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import { describe, expect, it, vi } from 'vitest';

import {
  type PinnedTransport,
  type PinnedTransportResponse,
  SafeOutboundHttpClient,
} from '@/server/enterprise/security/outboundHttp';
import { buildDingTalkDiscoveryMetadata } from '@/server/enterprise/services/identityProvider/kinds';

import {
  buildPlatformIdentityProvider,
  type RuntimeIdentityProvider,
} from './platformIdentityProvider';

const publicAddress = '93.184.216.34';
const nonce = 'unit-test-dingtalk-nonce';

const jsonResponse = (body: unknown): PinnedTransportResponse => ({
  body: Buffer.from(JSON.stringify(body)),
  headers: { 'content-type': 'application/json; charset=utf-8' },
  status: 200,
  statusText: 'OK',
});

const runtimeProvider = (
  allowlist: RuntimeIdentityProvider['dingtalkAllowedCorps'] = [
    { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' },
  ],
): RuntimeIdentityProvider => ({
  autoProvision: true,
  buttonLabel: '使用钉钉登录',
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: ['unionId'],
    email: ['email'],
    name: ['nick'],
    picture: ['avatarUrl'],
    subject: ['unionId', 'openId'],
  },
  clientId: 'app-key',
  clientSecret: 'app-secret',
  dingtalkAllowedCorps: allowlist,
  displayName: 'DingTalk',
  domainAllowlist: [],
  enabled: true,
  groupRoleMapping: {},
  icon: 'dingtalk',
  issuer: DINGTALK_IDENTITY_PROVIDER_ISSUER,
  oidcMetadata: buildDingTalkDiscoveryMetadata(DINGTALK_IDENTITY_PROVIDER_ISSUER),
  providerKey: 'dingtalk',
  revision: 1,
  scopes: ['openid', 'corpid'],
  secretFingerprint: 'a'.repeat(64),
  type: 'dingtalk',
  usePkce: true,
});

const setup = (options?: {
  allowlist?: RuntimeIdentityProvider['dingtalkAllowedCorps'];
  profile?: Record<string, unknown>;
  stateProviderId?: string;
  token?: Record<string, unknown>;
}) => {
  const transport = vi.fn<PinnedTransport>(async (request) => {
    if (request.url.pathname.endsWith('/oauth2/userAccessToken')) {
      return jsonResponse(
        options?.token ?? { accessToken: 'access-token', corpId: 'ding42', expireIn: 7200 },
      );
    }
    if (request.url.pathname.endsWith('/contact/users/me')) {
      expect(request.headers['x-acs-dingtalk-access-token']).toBe('access-token');
      expect(request.headers).not.toHaveProperty('Authorization');
      return jsonResponse(
        options?.profile ?? {
          avatarUrl: 'https://cdn.example.test/ada.png',
          nick: 'Ada',
          openId: 'open-1',
          unionId: 'union-1',
        },
      );
    }
    throw new Error(`Unexpected DingTalk request: ${request.url.pathname}`);
  });
  const outbound = new SafeOutboundHttpClient({
    mode: 'public-only',
    resolve: async () => [{ address: publicAddress, family: 4 }],
    transport,
  });
  const readOAuthState = (async () => ({
    callbackURL: 'https://app.example.test/after-login',
    expiresAt: Date.now() + 60_000,
    oauthState: 'flow-1',
    platformOidcNonceHash: createHash('sha256').update(nonce).digest('hex'),
    platformOidcProviderId: options?.stateProviderId ?? 'dingtalk',
  })) as unknown as typeof getOAuthState;
  const config = buildPlatformIdentityProvider(
    runtimeProvider(options?.allowlist),
    'https://app.example.test',
    outbound,
    readOAuthState,
  );
  return { config, transport };
};

describe('DingTalk platform identity provider adapter', () => {
  it('builds a non-OIDC generic OAuth config with PKCE disabled', () => {
    const { config } = setup();
    expect(config.providerId).toBe('dingtalk');
    expect(config.pkce).toBe(false);
    expect(config.requireIssuerValidation).toBeFalsy();
    expect(config.authorizationUrl).toBe('https://login.dingtalk.com/oauth2/auth');
    expect(config.tokenUrl).toBe('https://api.dingtalk.com/v1.0/oauth2/userAccessToken');
    expect(config.redirectURI).toBe('https://app.example.test/api/auth/oauth2/callback/dingtalk');
    expect(config.scopes).toEqual(['openid', 'corpid']);
  });

  it('binds the provider into OAuth state and asks DingTalk for an explicit consent screen', () => {
    const { config } = setup();
    const ctx = { body: {} as Record<string, unknown>, path: '/sign-in/oauth2' };
    const params = (config.authorizationUrlParams as (input: unknown) => Record<string, string>)(
      ctx,
    );
    expect(params.prompt).toBe('consent');
    expect(params.nonce).toHaveLength(43);
    const additionalData = ctx.body.additionalData as Record<string, string>;
    expect(additionalData.platformOidcProviderId).toBe('dingtalk');
    expect(additionalData.platformOidcNonceHash).toBe(
      createHash('sha256').update(params.nonce).digest('hex'),
    );
  });

  it('exchanges the code with a JSON body and never requires an id_token', async () => {
    const { config, transport } = setup();
    const token = await config.getToken!({
      code: 'authorization-code',
      redirectURI: 'https://app.example.test/api/auth/oauth2/callback/dingtalk',
    } as never);
    expect(token.accessToken).toBe('access-token');
    expect(token.idToken).toBeUndefined();
    const tokenRequest = transport.mock.calls[0]![0];
    expect(JSON.parse(tokenRequest.body!.toString())).toEqual({
      clientId: 'app-key',
      clientSecret: 'app-secret',
      code: 'authorization-code',
      grantType: 'authorization_code',
    });
  });

  it('enforces the organisation allowlist at getToken, before any profile or account access', async () => {
    const exchange = (config: GenericOAuthConfig) =>
      config.getToken!({
        code: 'authorization-code',
        redirectURI: 'https://app.example.test/api/auth/oauth2/callback/dingtalk',
      } as never);

    const allowed = setup();
    await expect(exchange(allowed.config)).resolves.toMatchObject({
      accessToken: 'access-token',
    });
    // Only the token endpoint was called — the profile endpoint is never reached before the gate.
    expect(allowed.transport).toHaveBeenCalledTimes(1);

    const foreign = setup({ token: { accessToken: 'access-token', corpId: 'ding99' } });
    await expect(exchange(foreign.config)).rejects.toThrow('PLATFORM_DINGTALK_CORP_NOT_ALLOWED');
    expect(foreign.transport).toHaveBeenCalledTimes(1);

    // No corpId at all (the `corpid` scope was not granted) is a rejection, never a pass.
    const scopeless = setup({ token: { accessToken: 'access-token' } });
    await expect(exchange(scopeless.config)).rejects.toThrow('PLATFORM_DINGTALK_CORP_NOT_ALLOWED');

    // Empty allowlist allows nobody.
    const empty = setup({ allowlist: [] });
    await expect(exchange(empty.config)).rejects.toThrow('PLATFORM_DINGTALK_CORP_NOT_ALLOWED');
  });

  it('maps the profile through the shared claim mapping with a synthetic email', async () => {
    const { config } = setup({
      profile: { avatarUrl: 'https://cdn.example.test/a.png', nick: 'Ada', unionId: 'union-1' },
    });
    const profile = await config.getUserInfo!({ accessToken: 'access-token' } as never);
    expect(profile).toMatchObject({ email: 'union-1@dingtalk.dingtalk.sso', sub: 'union-1' });
    expect(config.mapProfileToUser!(profile as never)).toMatchObject({
      dingtalkUserId: 'union-1',
      email: 'union-1@dingtalk.dingtalk.sso',
      id: 'union-1',
      image: 'https://cdn.example.test/a.png',
      name: 'Ada',
    });
  });

  it('rejects a callback whose OAuth state was bound to another provider', async () => {
    const { config } = setup({ stateProviderId: 'other-provider' });
    await expect(config.getUserInfo!({ accessToken: 'access-token' } as never)).rejects.toThrow(
      'PLATFORM_DINGTALK_STATE_INVALID',
    );
  });

  it('rejects a token response without an access token before touching any account', async () => {
    const { config } = setup();
    await expect(config.getUserInfo!({} as never)).rejects.toThrow(
      'PLATFORM_DINGTALK_TOKEN_INVALID',
    );
  });
});

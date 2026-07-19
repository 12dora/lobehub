// @vitest-environment node
import { genericOAuth } from 'better-auth/plugins';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  type PinnedTransport,
  type PinnedTransportResponse,
  SafeOutboundHttpClient,
} from '@/server/enterprise/security/outboundHttp';

import {
  buildPlatformIdentityProvider,
  type RuntimeIdentityProvider,
} from './platformIdentityProvider';

const issuer = 'https://login.example.test/application/o/work/';
const clientId = 'client-id';
const publicAddress = '93.184.216.34';

const provider = {
  autoProvision: true,
  buttonLabel: 'Work login',
  claimMapping: {
    dingtalkTitle: ['dingtalk_title'],
    dingtalkUserId: ['dingtalk_user_id'],
    email: ['mail', 'email'],
    name: ['display_name', 'name'],
    picture: ['avatar', 'picture'],
    subject: ['employee_id', 'sub'],
  },
  clientId,
  clientSecret: 'fake-client-secret',
  displayName: 'Work',
  domainAllowlist: ['example.test'],
  enabled: true,
  groupRoleMapping: {},
  icon: null,
  issuer,
  providerKey: 'corp-oidc',
  revision: 4,
  scopes: ['openid', 'profile', 'email', 'dingtalk'],
  secretFingerprint: 'a'.repeat(64),
  type: 'authentik',
  usePkce: true,
} as const satisfies RuntimeIdentityProvider;

const jsonResponse = (body: unknown): PinnedTransportResponse => ({
  body: Buffer.from(JSON.stringify(body)),
  headers: { 'content-type': 'application/json; charset=utf-8' },
  status: 200,
  statusText: 'OK',
});

const setup = async (options?: {
  discovery?: Record<string, unknown>;
  jwks?: Record<string, unknown>;
  userInfo?: Record<string, unknown>;
}) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'key-1', use: 'sig' };
  const metadata = {
    authorization_endpoint: 'https://login.example.test/application/o/authorize/',
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256'],
    issuer,
    jwks_uri: 'https://login.example.test/application/o/work/jwks/',
    response_types_supported: ['code'],
    scopes_supported: ['openid', 'profile', 'email', 'dingtalk'],
    subject_types_supported: ['public'],
    token_endpoint: 'https://login.example.test/application/o/token/',
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    userinfo_endpoint: 'https://login.example.test/application/o/userinfo/',
    ...options?.discovery,
  };
  const userInfo = {
    avatar: 'https://cdn.example.test/ada.png',
    display_name: 'Ada',
    dingtalk_title: 'Engineering Manager',
    dingtalk_user_id: 'ding-user-1',
    employee_id: 'employee-1',
    mail: 'ada@example.test',
    sub: 'employee-1',
    ...options?.userInfo,
  };
  const transport = vi.fn<PinnedTransport>(async (request) => {
    if (request.url.pathname.endsWith('/.well-known/openid-configuration')) {
      return jsonResponse(metadata);
    }
    if (request.url.pathname.endsWith('/jwks/')) {
      return jsonResponse(options?.jwks ?? { keys: [publicJwk] });
    }
    if (request.url.pathname.endsWith('/userinfo/')) {
      expect(request.headers.Authorization).toBe('Bearer access-token');
      return jsonResponse(userInfo);
    }
    throw new Error(`Unexpected OIDC request: ${request.url.pathname}`);
  });
  const outbound = new SafeOutboundHttpClient({
    mode: 'public-only',
    resolve: async () => [{ address: publicAddress, family: 4 }],
    transport,
  });
  const config = buildPlatformIdentityProvider(provider, 'https://app.example.test', outbound);
  const plugin = genericOAuth({ config: [config] });
  const oauthProvider = plugin.init({
    baseURL: 'https://app.example.test/api/auth',
    socialProviders: [],
  } as never).context.socialProviders[0]!;
  const now = Math.floor(Date.now() / 1000);
  const sign = (claims: Record<string, unknown> = {}, key = privateKey, kid = 'key-1') =>
    new SignJWT({
      aud: clientId,
      email: 'ada@example.test',
      exp: now + 300,
      iat: now,
      iss: issuer,
      name: 'Ada',
      sub: 'employee-1',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .sign(key);

  return { oauthProvider, sign, transport };
};

describe('platform identity provider trusted profile', () => {
  it('uses verified ID token identity plus protected userinfo claims in Better Auth mapping', async () => {
    const { oauthProvider, sign, transport } = await setup();

    const result = await oauthProvider.getUserInfo({
      accessToken: 'access-token',
      idToken: await sign(),
    });

    expect(result?.user).toMatchObject({
      dingtalkTitle: 'Engineering Manager',
      dingtalkUserId: 'ding-user-1',
      email: 'ada@example.test',
      id: 'employee-1',
      image: 'https://cdn.example.test/ada.png',
      name: 'Ada',
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('rejects a token with the wrong issuer or audience', async () => {
    const { oauthProvider, sign } = await setup();

    await expect(
      oauthProvider.getUserInfo({
        accessToken: 'access-token',
        idToken: await sign({ iss: 'https://attacker.example.test/' }),
      }),
    ).rejects.toThrow('PLATFORM_OIDC_ID_TOKEN_INVALID');
    await expect(
      oauthProvider.getUserInfo({
        accessToken: 'access-token',
        idToken: await sign({ aud: 'attacker-client' }),
      }),
    ).rejects.toThrow('PLATFORM_OIDC_ID_TOKEN_INVALID');
  });

  it('rejects forged signatures and an unknown JWKS key', async () => {
    const { privateKey: attackerKey } = await generateKeyPair('RS256');
    const signedByAttacker = await setup();
    await expect(
      signedByAttacker.oauthProvider.getUserInfo({
        accessToken: 'access-token',
        idToken: await signedByAttacker.sign({}, attackerKey),
      }),
    ).rejects.toThrow('PLATFORM_OIDC_ID_TOKEN_INVALID');

    const unknownKey = await setup();
    await expect(
      unknownKey.oauthProvider.getUserInfo({
        accessToken: 'access-token',
        idToken: await unknownKey.sign({}, undefined, 'unknown-key'),
      }),
    ).rejects.toThrow('PLATFORM_OIDC_ID_TOKEN_INVALID');
  });

  it('rejects discovery issuer substitution and userinfo subject substitution', async () => {
    const wrongDiscovery = await setup({
      discovery: { issuer: 'https://attacker.example.test/' },
    });
    await expect(
      wrongDiscovery.oauthProvider.getUserInfo({
        accessToken: 'access-token',
        idToken: await wrongDiscovery.sign(),
      }),
    ).rejects.toThrow('OIDC_DISCOVERY_INVALID');

    const wrongSubject = await setup({ userInfo: { sub: 'attacker-subject' } });
    await expect(
      wrongSubject.oauthProvider.getUserInfo({
        accessToken: 'access-token',
        idToken: await wrongSubject.sign(),
      }),
    ).rejects.toThrow('PLATFORM_OIDC_USERINFO_SUBJECT_MISMATCH');
  });
});

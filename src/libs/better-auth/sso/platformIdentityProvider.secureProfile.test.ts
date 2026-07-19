// @vitest-environment node
import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.restoreAllMocks();
});

const baseProvider: Omit<RuntimeIdentityProvider, 'issuer' | 'oidcMetadata'> = {
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
  providerKey: 'corp-oidc',
  revision: 4,
  scopes: ['openid', 'profile', 'email', 'dingtalk'],
  secretFingerprint: 'a'.repeat(64),
  type: 'authentik',
  usePkce: true,
};

const jsonResponse = (body: unknown): PinnedTransportResponse => ({
  body: Buffer.from(JSON.stringify(body)),
  headers: { 'content-type': 'application/json; charset=utf-8' },
  status: 200,
  statusText: 'OK',
});

const setup = async (options?: {
  jwks?: Record<string, unknown>;
  token?: Record<string, unknown>;
  userInfo?: Record<string, unknown>;
}) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'key-1', use: 'sig' };
  const oidcMetadata = {
    authorizationEndpoint: 'https://login.example.test/application/o/authorize/',
    codeChallengeMethodsSupported: ['S256'],
    idTokenSigningAlgValuesSupported: ['RS256'],
    issuer,
    jwksUri: 'https://login.example.test/application/o/work/jwks/',
    responseTypesSupported: ['code'],
    scopesSupported: ['openid', 'profile', 'email', 'dingtalk'],
    subjectTypesSupported: ['public'],
    tokenEndpoint: 'https://login.example.test/application/o/token/',
    tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
    userinfoEndpoint: 'https://login.example.test/application/o/userinfo/',
  };
  const provider = { ...baseProvider, issuer, oidcMetadata } satisfies RuntimeIdentityProvider;
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
    if (request.url.pathname.endsWith('/token/'))
      return jsonResponse(
        options?.token ?? { access_token: 'access-token', id_token: await sign() },
      );
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
  return { config, oauthProvider, sign, transport };
};

describe('platform identity provider trusted profile', () => {
  it('creates authorization and exchanges tokens without Better Auth discovery or token fetches', async () => {
    const { oauthProvider, transport } = await setup({
      token: { access_token: 'access-token', id_token: 'id-token' },
    });

    const authorizationUrl = await oauthProvider.createAuthorizationURL({
      codeVerifier: 'pkce-verifier',
      redirectURI: 'https://app.example.test/api/auth/oauth2/callback/corp-oidc',
      state: 'state',
    });
    expect(authorizationUrl.toString()).toContain('/application/o/authorize/');
    expect(transport).not.toHaveBeenCalled();

    await expect(
      oauthProvider.validateAuthorizationCode({
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        redirectURI: 'https://app.example.test/api/auth/oauth2/callback/corp-oidc',
      }),
    ).resolves.toMatchObject({ accessToken: 'access-token', idToken: 'id-token' });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]![0].url.pathname).toBe('/application/o/token/');
  });

  it('runs the Better Auth sign-in and callback routes without native discovery or token fetches', async () => {
    const { config, transport } = await setup();
    const customGetToken = vi.spyOn(config, 'getToken');
    const nativeFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected native OAuth fetch'));
    const baseURL = 'https://app.example.test/api/auth';
    const auth = betterAuth({
      baseURL,
      plugins: [genericOAuth({ config: [config] })],
      secret: 'platform-oidc-route-regression-secret',
    });

    const signInResponse = await auth.handler(
      new Request(`${baseURL}/sign-in/oauth2`, {
        body: JSON.stringify({
          callbackURL: 'https://app.example.test/after-login',
          disableRedirect: true,
          providerId: 'corp-oidc',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    const signInBody = (await signInResponse.json()) as { redirect: boolean; url: string };
    const authorizationUrl = new URL(signInBody.url);
    expect(signInResponse.status).toBe(200);
    expect(signInBody.redirect).toBe(false);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      'https://login.example.test/application/o/authorize/',
    );
    expect(authorizationUrl.searchParams.get('state')).toBeTruthy();
    expect(signInResponse.headers.get('set-cookie')).toContain('better-auth.oauth_state=');
    expect(transport).not.toHaveBeenCalled();
    expect(nativeFetch).not.toHaveBeenCalled();

    const cookie = signInResponse.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    const callbackUrl = new URL(`${baseURL}/oauth2/callback/corp-oidc`);
    callbackUrl.searchParams.set('code', 'authorization-code');
    callbackUrl.searchParams.set('iss', issuer);
    callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
    const callbackResponse = await auth.handler(
      new Request(callbackUrl, { headers: { Cookie: cookie } }),
    );

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get('location')).toBe('https://app.example.test/after-login');
    expect(customGetToken).toHaveBeenCalledOnce();
    expect(transport.mock.calls.map(([request]) => request.url.pathname)).toEqual([
      '/application/o/token/',
      '/application/o/work/jwks/',
      '/application/o/userinfo/',
    ]);
    expect(
      transport.mock.calls.some(([request]) => request.url.hostname.endsWith('.invalid')),
    ).toBe(false);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

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
    expect(transport).toHaveBeenCalledTimes(2);
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

  it('rejects userinfo subject substitution', async () => {
    const wrongSubject = await setup({ userInfo: { sub: 'attacker-subject' } });
    await expect(
      wrongSubject.oauthProvider.getUserInfo({
        accessToken: 'access-token',
        idToken: await wrongSubject.sign(),
      }),
    ).rejects.toThrow('PLATFORM_OIDC_USERINFO_SUBJECT_MISMATCH');
  });
});

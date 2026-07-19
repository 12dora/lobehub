// @vitest-environment node
import { createHash } from 'node:crypto';

import { betterAuth } from 'better-auth';
import type { MemoryDB } from 'better-auth/adapters/memory';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createAuthMiddleware } from 'better-auth/api';
import { genericOAuth } from 'better-auth/plugins';
import type { BetterAuthPlugin } from 'better-auth/types';
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
import { platformIdentityProviderState } from './platformIdentityProviderState';

const issuer = 'https://login.example.test/application/o/work/';
const clientId = 'client-id';
const publicAddress = '93.184.216.34';
const unitNonce = 'unit-test-platform-oidc-nonce';

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
  missingOAuthState?: boolean;
  omitStateNonceHash?: boolean;
  omitStateProviderId?: boolean;
  stateProviderId?: string;
  token?: Record<string, unknown>;
  userInfo?: Record<string, unknown>;
  useProtectedRouteState?: boolean;
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
  let tokenNonce: string | undefined = unitNonce;
  const tokenNoncesByCode = new Map<string, string | undefined>();
  const now = Math.floor(Date.now() / 1000);
  const sign = (claims: Record<string, unknown> = {}, key = privateKey, kid = 'key-1') =>
    new SignJWT({
      aud: clientId,
      email: 'ada@example.test',
      exp: now + 300,
      iat: now,
      iss: issuer,
      name: 'Ada',
      ...(tokenNonce === undefined ? {} : { nonce: tokenNonce }),
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
    if (request.url.pathname.endsWith('/token/')) {
      const code = new URLSearchParams(request.body?.toString()).get('code');
      const nonce = code && tokenNoncesByCode.has(code) ? tokenNoncesByCode.get(code) : tokenNonce;
      const previousNonce = tokenNonce;
      tokenNonce = nonce;
      const idToken = await sign();
      tokenNonce = previousNonce;
      return jsonResponse(options?.token ?? { access_token: 'access-token', id_token: idToken });
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
  const config = options?.useProtectedRouteState
    ? buildPlatformIdentityProvider(provider, 'https://app.example.test', outbound)
    : buildPlatformIdentityProvider(provider, 'https://app.example.test', outbound, async () =>
        options?.missingOAuthState
          ? null
          : {
              callbackURL: 'https://app.example.test/after-login',
              codeVerifier: 'pkce-verifier',
              expiresAt: Date.now() + 60_000,
              ...(options?.omitStateNonceHash
                ? {}
                : {
                    platformOidcNonceHash: createHash('sha256').update(unitNonce).digest('hex'),
                  }),
              ...(options?.omitStateProviderId
                ? {}
                : { platformOidcProviderId: options?.stateProviderId ?? 'corp-oidc' }),
            },
      );
  const plugin = genericOAuth({ config: [config] });
  const oauthProvider = plugin.init({
    baseURL: 'https://app.example.test/api/auth',
    socialProviders: [],
  } as never).context.socialProviders[0]!;
  return {
    config,
    oauthProvider,
    setTokenNonce: (nonce: string | undefined) => {
      tokenNonce = nonce;
    },
    setTokenNonceForCode: (code: string, nonce: string | undefined) => {
      tokenNoncesByCode.set(code, nonce);
    },
    sign,
    transport,
  };
};

interface RouteHarnessOptions extends NonNullable<Parameters<typeof setup>[0]> {
  failLinkStateUpdate?: boolean;
}

const createRouteHarness = async (options?: RouteHarnessOptions) => {
  const setupResult = await setup({ ...options, useProtectedRouteState: true });
  const database: MemoryDB = {
    account: [],
    session: [],
    user: [],
    verification: [],
  };
  const secondaryStorage = new Map<string, string>();
  const nativeFetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected native OAuth fetch'));
  const customGetToken = vi.spyOn(setupResult.config, 'getToken');
  const mapProfileToUser = vi.spyOn(setupResult.config, 'mapProfileToUser');
  const baseURL = 'https://app.example.test/api/auth';
  const failLinkStateUpdatePlugin: BetterAuthPlugin = {
    hooks: {
      before: [
        {
          handler: createAuthMiddleware(async (ctx) => {
            if (!options?.failLinkStateUpdate) return;
            const updateMany = ctx.context.adapter.updateMany.bind(ctx.context.adapter);
            ctx.context.adapter.updateMany = async (input) => {
              if (
                input.model === 'verification' &&
                input.where.some((where) => where.field === 'value')
              ) {
                return 0;
              }
              return updateMany(input);
            };
          }),
          matcher: (ctx) => ctx.path === '/oauth2/link',
        },
      ],
    },
    id: 'fail-platform-state-update-test',
  };
  const createAuthInstance = () =>
    betterAuth({
      account: {
        accountLinking: { allowDifferentEmails: true, enabled: true },
        storeStateStrategy: 'database',
      },
      baseURL,
      database: memoryAdapter(database),
      emailAndPassword: { enabled: true },
      plugins: [
        failLinkStateUpdatePlugin,
        platformIdentityProviderState(['corp-oidc']),
        genericOAuth({ config: [setupResult.config] }),
      ],
      secondaryStorage: {
        delete: async (key) => {
          secondaryStorage.delete(key);
        },
        get: async (key) => secondaryStorage.get(key) ?? null,
        set: async (key, value) => {
          secondaryStorage.set(key, value);
        },
      },
      secret: 'platform-oidc-route-regression-secret',
      verification: { storeInDatabase: true },
    });
  const signInAuth = createAuthInstance();
  const callbackAuth = createAuthInstance();
  const start = async (additionalData?: Record<string, unknown>) => {
    const response = await signInAuth.handler(
      new Request(`${baseURL}/sign-in/oauth2`, {
        body: JSON.stringify({
          additionalData,
          callbackURL: 'https://app.example.test/after-login',
          disableRedirect: true,
          providerId: 'corp-oidc',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { redirect: boolean; url: string };
    const authorizationUrl = new URL(body.url);
    return {
      authorizationUrl,
      body,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';', 1)[0])
        .join('; '),
      response,
    };
  };
  const callback = async (
    flow: { authorizationUrl: URL; cookie: string },
    overrides: { code?: string; cookie?: string; state?: string | null } = {},
  ) => {
    const callbackUrl = new URL(`${baseURL}/oauth2/callback/corp-oidc`);
    callbackUrl.searchParams.set('code', overrides.code ?? 'authorization-code');
    callbackUrl.searchParams.set('iss', issuer);
    const state =
      overrides.state === undefined
        ? flow.authorizationUrl.searchParams.get('state')
        : overrides.state;
    if (state !== null) callbackUrl.searchParams.set('state', state);
    return callbackAuth.handler(
      new Request(callbackUrl, { headers: { Cookie: overrides.cookie ?? flow.cookie } }),
    );
  };
  const authenticate = async () => {
    const response = await signInAuth.handler(
      new Request(`${baseURL}/sign-up/email`, {
        body: JSON.stringify({
          email: 'ada@example.test',
          name: 'Ada',
          password: 'correct-horse-battery-staple',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
  };
  const startLink = async (sessionCookie: string) => {
    const response = await signInAuth.handler(
      new Request(`${baseURL}/oauth2/link`, {
        body: JSON.stringify({
          callbackURL: 'https://app.example.test/after-link',
          providerId: 'corp-oidc',
        }),
        headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie },
        method: 'POST',
      }),
    );
    const responseText = await response.text();
    const body = (responseText ? JSON.parse(responseText) : {}) as {
      redirect?: boolean;
      url?: string;
    };
    return {
      authorizationUrl: body.url ? new URL(body.url) : null,
      body,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';', 1)[0])
        .join('; '),
      response,
    };
  };

  return {
    ...setupResult,
    authenticate,
    callback,
    customGetToken,
    database,
    mapProfileToUser,
    nativeFetch,
    start,
    startLink,
  };
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

  it('binds unique nonces to database state across concurrent Better Auth route flows', async () => {
    const harness = await createRouteHarness();
    const [first, second] = await Promise.all([
      harness.start({
        platformOidcNonceHash: 'client-controlled-hash',
        platformOidcProviderId: 'attacker-provider',
        reauth: true,
      }),
      harness.start(),
    ]);
    const firstNonce = first.authorizationUrl.searchParams.get('nonce');
    const secondNonce = second.authorizationUrl.searchParams.get('nonce');

    expect(first.response.status).toBe(200);
    expect(first.body.redirect).toBe(false);
    expect(first.authorizationUrl.origin + first.authorizationUrl.pathname).toBe(
      'https://login.example.test/application/o/authorize/',
    );
    expect(first.authorizationUrl.searchParams.get('state')).toBeTruthy();
    expect(first.authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(first.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(first.authorizationUrl.searchParams.get('prompt')).toBe('login');
    expect(first.authorizationUrl.searchParams.get('max_age')).toBe('0');
    expect(first.cookie).toContain('better-auth.state=');
    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
    expect(first.authorizationUrl.searchParams.get('state')).not.toBe(
      second.authorizationUrl.searchParams.get('state'),
    );
    expect(JSON.stringify(harness.database)).toContain(
      createHash('sha256').update(firstNonce!).digest('hex'),
    );
    expect(JSON.stringify(harness.database)).not.toContain('client-controlled-hash');
    expect(JSON.stringify(harness.database)).not.toContain('attacker-provider');
    expect(JSON.stringify(harness.database)).not.toContain(firstNonce);
    expect(JSON.stringify(harness.database)).not.toContain(secondNonce);
    expect(harness.transport).not.toHaveBeenCalled();

    harness.setTokenNonceForCode('first-code', firstNonce!);
    harness.setTokenNonceForCode('second-code', secondNonce!);
    const [firstCallback, secondCallback] = await Promise.all([
      harness.callback(first, { code: 'first-code' }),
      harness.callback(second, { code: 'second-code' }),
    ]);

    expect(firstCallback.status).toBe(302);
    expect(firstCallback.headers.get('location')).toBe('https://app.example.test/after-login');
    expect(secondCallback.status).toBe(302);
    expect(secondCallback.headers.get('location')).toBe('https://app.example.test/after-login');
    expect(harness.customGetToken).toHaveBeenCalledTimes(2);
    expect(
      harness.transport.mock.calls
        .map(([request]) => request.url.pathname)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(
      [
        '/application/o/token/',
        '/application/o/work/jwks/',
        '/application/o/userinfo/',
        '/application/o/token/',
        '/application/o/work/jwks/',
        '/application/o/userinfo/',
      ].sort((left, right) => left.localeCompare(right)),
    );
    expect(
      harness.transport.mock.calls.some(([request]) => request.url.hostname.endsWith('.invalid')),
    ).toBe(false);
    expect(harness.nativeFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.database)).not.toContain(firstNonce);
    expect(JSON.stringify(harness.database)).not.toContain(secondNonce);
    expect(harness.database.account).toHaveLength(2);
    expect(harness.database.account?.every((account) => account.idToken === undefined)).toBe(true);
  });

  it('binds link nonce to persisted state before returning the URL and completes cross-instance callback', async () => {
    const harness = await createRouteHarness();
    const sessionCookie = await harness.authenticate();
    const flow = await harness.startLink(sessionCookie);

    expect(flow.response.status).toBe(200);
    expect(flow.body.redirect).toBe(true);
    expect(flow.authorizationUrl).not.toBeNull();
    const state = flow.authorizationUrl!.searchParams.get('state');
    const nonce = flow.authorizationUrl!.searchParams.get('nonce');
    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();
    expect(flow.cookie).toContain('better-auth.state=');

    const verification = harness.database.verification?.find((entry) => entry.identifier === state);
    expect(verification).toBeDefined();
    const persistedState = JSON.parse(verification!.value) as Record<string, unknown>;
    expect(persistedState).toMatchObject({
      callbackURL: 'https://app.example.test/after-link',
      expiresAt: expect.any(Number),
      link: { email: 'ada@example.test', userId: expect.any(String) },
      oauthState: state,
      platformOidcNonceHash: createHash('sha256').update(nonce!).digest('hex'),
      platformOidcProviderId: 'corp-oidc',
    });
    expect(persistedState.codeVerifier).toEqual(expect.any(String));
    expect(verification!.expiresAt).toBeInstanceOf(Date);
    expect(verification!.value).not.toContain(nonce!);

    harness.setTokenNonce(nonce!);
    const response = await harness.callback({ ...flow, authorizationUrl: flow.authorizationUrl! });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://app.example.test/after-link');
    expect(harness.customGetToken).toHaveBeenCalledOnce();
    expect(harness.mapProfileToUser).toHaveBeenCalledOnce();
    expect(harness.database.account).toHaveLength(2);
    expect(
      harness.database.account?.find((account) => account.providerId === 'corp-oidc'),
    ).toBeDefined();
    expect(harness.nativeFetch).not.toHaveBeenCalled();
  });

  it('fails the real link handler closed when nonce-state CAS publication fails', async () => {
    const harness = await createRouteHarness({ failLinkStateUpdate: true });
    const sessionCookie = await harness.authenticate();

    const flow = await harness.startLink(sessionCookie);

    expect(flow.response.status).toBe(500);
    expect(flow.body).not.toHaveProperty('url');
    expect(JSON.stringify(flow.body)).not.toContain('login.example.test');
    expect(harness.transport).not.toHaveBeenCalled();
    expect(harness.customGetToken).not.toHaveBeenCalled();
    expect(harness.mapProfileToUser).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.database)).not.toContain('platformOidcNonceHash');
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'attacker-link-nonce'],
  ])('rejects a linked account ID token with a %s nonce', async (_label, tokenNonce) => {
    const harness = await createRouteHarness();
    const sessionCookie = await harness.authenticate();
    const flow = await harness.startLink(sessionCookie);
    expect(flow.authorizationUrl).not.toBeNull();
    harness.setTokenNonce(tokenNonce);

    const response = await harness.callback({ ...flow, authorizationUrl: flow.authorizationUrl! });

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.headers.get('location')).not.toBe('https://app.example.test/after-link');
    expect(harness.customGetToken).toHaveBeenCalledOnce();
    expect(harness.mapProfileToUser).not.toHaveBeenCalled();
    expect(harness.database.account).toHaveLength(1);
  });

  it('consumes linked-account database state once before token exchange replay', async () => {
    const harness = await createRouteHarness();
    const sessionCookie = await harness.authenticate();
    const flow = await harness.startLink(sessionCookie);
    expect(flow.authorizationUrl).not.toBeNull();
    harness.setTokenNonce(flow.authorizationUrl!.searchParams.get('nonce')!);

    const first = await harness.callback({ ...flow, authorizationUrl: flow.authorizationUrl! });
    const callsAfterSuccess = harness.transport.mock.calls.length;
    const replay = await harness.callback({ ...flow, authorizationUrl: flow.authorizationUrl! });

    expect(first.headers.get('location')).toBe('https://app.example.test/after-link');
    expect(replay.headers.get('location')).not.toBe('https://app.example.test/after-link');
    expect(harness.customGetToken).toHaveBeenCalledOnce();
    expect(harness.transport).toHaveBeenCalledTimes(callsAfterSuccess);
    expect(harness.mapProfileToUser).toHaveBeenCalledOnce();
  });

  it('isolates concurrent link nonce state and callbacks across auth instances', async () => {
    const harness = await createRouteHarness();
    const sessionCookie = await harness.authenticate();
    const [first, second] = await Promise.all([
      harness.startLink(sessionCookie),
      harness.startLink(sessionCookie),
    ]);
    expect(first.authorizationUrl).not.toBeNull();
    expect(second.authorizationUrl).not.toBeNull();
    const firstNonce = first.authorizationUrl!.searchParams.get('nonce');
    const secondNonce = second.authorizationUrl!.searchParams.get('nonce');
    const firstState = first.authorizationUrl!.searchParams.get('state');
    const secondState = second.authorizationUrl!.searchParams.get('state');
    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
    expect(firstState).not.toBe(secondState);
    expect(JSON.stringify(harness.database)).not.toContain(firstNonce);
    expect(JSON.stringify(harness.database)).not.toContain(secondNonce);
    harness.setTokenNonceForCode('first-link-code', firstNonce!);
    harness.setTokenNonceForCode('second-link-code', secondNonce!);

    const [firstCallback, secondCallback] = await Promise.all([
      harness.callback(
        { ...first, authorizationUrl: first.authorizationUrl! },
        {
          code: 'first-link-code',
        },
      ),
      harness.callback(
        { ...second, authorizationUrl: second.authorizationUrl! },
        {
          code: 'second-link-code',
        },
      ),
    ]);

    expect(firstCallback.headers.get('location')).toBe('https://app.example.test/after-link');
    expect(secondCallback.headers.get('location')).toBe('https://app.example.test/after-link');
    expect(harness.customGetToken).toHaveBeenCalledTimes(2);
    expect(harness.mapProfileToUser).toHaveBeenCalledTimes(2);
    expect(harness.database.account?.every((account) => account.idToken === undefined)).toBe(true);
    expect(JSON.stringify(harness.database)).not.toContain(firstNonce);
    expect(JSON.stringify(harness.database)).not.toContain(secondNonce);
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'attacker-nonce'],
  ])('rejects an ID token with a %s nonce before mapping or persistence', async (_label, nonce) => {
    const harness = await createRouteHarness();
    const flow = await harness.start();
    harness.setTokenNonce(nonce);

    const response = await harness.callback(flow);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(harness.customGetToken).toHaveBeenCalledOnce();
    expect(harness.mapProfileToUser).not.toHaveBeenCalled();
    expect(harness.transport.mock.calls.map(([request]) => request.url.pathname)).toEqual([
      '/application/o/token/',
      '/application/o/work/jwks/',
    ]);
    expect(JSON.stringify(harness.database)).not.toContain('employee-1');
    expect(harness.nativeFetch).not.toHaveBeenCalled();
  });

  it('rejects a missing ID token in the real callback before mapping or persistence', async () => {
    const harness = await createRouteHarness({ token: { access_token: 'access-token' } });
    const flow = await harness.start();

    const response = await harness.callback(flow);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).not.toBe('https://app.example.test/after-login');
    expect(harness.customGetToken).toHaveBeenCalledOnce();
    expect(harness.mapProfileToUser).not.toHaveBeenCalled();
    expect(harness.transport.mock.calls.map(([request]) => request.url.pathname)).toEqual([
      '/application/o/token/',
    ]);
    expect(JSON.stringify(harness.database)).not.toContain('employee-1');
  });

  it.each([
    ['missing state', null, undefined],
    ['wrong state', 'attacker-state', undefined],
    ['state/cookie mismatch', undefined, 'better-auth.state=attacker-cookie'],
  ])('rejects %s before token exchange', async (_label, state, cookie) => {
    const harness = await createRouteHarness();
    const flow = await harness.start();

    const response = await harness.callback(flow, { cookie, state });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).not.toBe('https://app.example.test/after-login');
    expect(harness.customGetToken).not.toHaveBeenCalled();
    expect(harness.transport).not.toHaveBeenCalled();
    expect(harness.mapProfileToUser).not.toHaveBeenCalled();
  });

  it('consumes database OAuth state once before token exchange', async () => {
    const harness = await createRouteHarness();
    const flow = await harness.start();
    harness.setTokenNonce(flow.authorizationUrl.searchParams.get('nonce')!);
    const first = await harness.callback(flow);
    const callsAfterSuccess = harness.transport.mock.calls.length;

    const replay = await harness.callback(flow);

    expect(first.headers.get('location')).toBe('https://app.example.test/after-login');
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).not.toBe('https://app.example.test/after-login');
    expect(harness.customGetToken).toHaveBeenCalledOnce();
    expect(harness.transport).toHaveBeenCalledTimes(callsAfterSuccess);
    expect(harness.mapProfileToUser).toHaveBeenCalledOnce();
  });

  it('rejects expired database OAuth state before token exchange', async () => {
    const harness = await createRouteHarness();
    const flow = await harness.start();
    vi.useFakeTimers({ now: Date.now() });
    try {
      await vi.advanceTimersByTimeAsync(600_001);
      const response = await harness.callback(flow);

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).not.toBe('https://app.example.test/after-login');
      expect(harness.customGetToken).not.toHaveBeenCalled();
      expect(harness.transport).not.toHaveBeenCalled();
      expect(harness.mapProfileToUser).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['missing OAuth state', { missingOAuthState: true }],
    ['missing nonce hash', { omitStateNonceHash: true }],
    ['missing provider binding', { omitStateProviderId: true }],
    ['wrong provider binding', { stateProviderId: 'other-provider' }],
  ])('rejects %s before JWKS or profile work', async (_label, options) => {
    const { oauthProvider, sign, transport } = await setup(options);

    await expect(
      oauthProvider.getUserInfo({ accessToken: 'access-token', idToken: await sign() }),
    ).rejects.toThrow('PLATFORM_OIDC_NONCE_INVALID');
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses verified ID token identity plus protected userinfo claims in Better Auth mapping', async () => {
    const { oauthProvider, sign, transport } = await setup();
    const tokens = {
      accessToken: 'access-token',
      idToken: await sign(),
    };

    const result = await oauthProvider.getUserInfo(tokens);

    expect(result?.user).toMatchObject({
      dingtalkTitle: 'Engineering Manager',
      dingtalkUserId: 'ding-user-1',
      email: 'ada@example.test',
      id: 'employee-1',
      image: 'https://cdn.example.test/ada.png',
      name: 'Ada',
    });
    expect(result?.data).not.toHaveProperty('nonce');
    expect(tokens.idToken).toBeUndefined();
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

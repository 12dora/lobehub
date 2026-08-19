import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import {
  DEFAULT_BROWSER_DEVICE_PROFILE,
  generateBrowserDeviceProfile,
} from '@lobechat/model-runtime/browserProfile';
import {
  buildChatGptWebXhrHeaders,
  COOKIE_JAR_HEADER,
  deriveSessionId,
} from '@lobechat/model-runtime/chatgptWebIdentity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getBrowserSessionRegistry,
  resetBrowserSessionRegistryForTests,
} from '@/server/enterprise/services/browserSession/contextRegistry';
import { readBrowserCookieJar } from '@/server/enterprise/services/browserSession/cookieJar';
import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import {
  bindChatGPTWebBrowserSession,
  invalidateChatGPTWebBrowserSession,
  rotateChatGPTWebBrowserSession,
} from './browserSession';
import {
  ChatGPTWebOAuthError,
  ChatGPTWebOAuthService,
  type ChatGPTWebPasteEnvelope,
  parseCallbackInput,
  parsePasteEnvelope,
  resolveChatGPTWebConnectDeviceId,
  sessionHeaders,
  wipeChatGPTWebCookieJar,
} from './oauthService';
import { readMatchingSessionChunksFromJar, seedChatGPTWebSessionJar } from './sessionCookie';
import { resetCookieJars, resolveCookieJarPath, seedCookieJar } from './transport';

const PROFILE = DEFAULT_BROWSER_DEVICE_PROFILE;
/** Stands in for the installation's persisted profile (never the bundled fallback). */
const PERSISTED_PROFILE = generateBrowserDeviceProfile({ seed: 'oauth-service-installation' });

const config: OAuthDeviceFlowConfig = {
  allowAccessTokenPaste: true,
  authorizationCode: {
    audience: 'https://api.openai.com/v1',
    authorizeEndpoint: 'https://auth.openai.com/api/accounts/authorize',
    redirectUri: 'https://platform.openai.com/auth/callback',
  },
  clientId: 'app_2SKx67EdpoN0G6j64rFvigXD',
  deviceCodeEndpoint: 'https://auth.openai.com/api/accounts/authorize',
  grantFlow: 'authorization_code_paste',
  refreshTokenGrant: true,
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  tokenExchangeEndpoint: 'https://auth.openai.com/api/accounts/oauth/token',
};

const jwt = (claims: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig',
  ].join('.');

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

const SESSION_COOKIE = '__Secure-next-auth.session-token';

/** next-auth compact JWE (`dir` header, empty encrypted-key segment) — a real session shape. */
const SESSION_JWE = [
  Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url'),
  '',
  'aXY',
  'Y3Q',
  'dGFn',
].join('.');

/** `/api/auth/session` answer, optionally rotating the cookie the way next-auth does. */
const sessionResponse = (body: unknown, options: { setCookie?: string[] } = {}) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of options.setCookie ?? []) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { headers, status: 200 });
};

/**
 * A 200 whose BODY never arrives — a dropped connection, a truncated response, an
 * interstitial. Distinct from a parsed body that carries no token, which is a dead session.
 */
const unreadableBodyResponse = (setCookie: string[] = []) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of setCookie) headers.append('set-cookie', cookie);
  const response = new Response('{"accessToken":', { headers, status: 200 });
  // Force the read itself to fail, not just the parse — the failure mode is the same.
  Object.defineProperty(response, 'json', {
    value: () => Promise.reject(new TypeError('terminated')),
  });
  return response;
};

/** The cookie header a call to `/api/auth/session` went out with. */
const sessionCookieOf = (transportFetch: ReturnType<typeof vi.fn>, index = 0): string =>
  transportFetch.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/session'))[index][1]
    .headers.cookie;

/** What Cloudflare actually answers with when it intercepts the call. */
const challengeResponse = () =>
  new Response('<html>', { headers: { 'cf-mitigated': 'challenge' }, status: 403 });

/**
 * Run a call that retries, without waiting out the real backoff.
 *
 * `AbortSignal.timeout` is native and unaffected by fake timers, so the overall budget
 * stays real (i.e. never fires here) while the backoff sleeps are driven instantly.
 */
const withFakeTimers = async <T>(run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers();
  try {
    const settled = run();
    // Past the whole jittered schedule (400 + 900 + 1600, +30 %).
    await vi.advanceTimersByTimeAsync(10_000);
    return await settled;
  } finally {
    vi.useRealTimers();
  }
};

const futureExp = Math.floor(Date.now() / 1000) + 86_400;

afterEach(async () => {
  await Promise.resolve(resetCookieJars());
  await resetBrowserSessionRegistryForTests();
});

describe('ChatGPTWebOAuthService.initiateDeviceCode', () => {
  it('builds the authorize URL with the full PKCE parameter set', async () => {
    const service = new ChatGPTWebOAuthService();
    const result = await service.initiateDeviceCode(config);

    const url = new URL(result.verificationUri);
    const params = url.searchParams;
    const envelope = JSON.parse(result.deviceCode) as ChatGPTWebPasteEnvelope;

    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(params.get('issuer')).toBe('https://auth.openai.com');
    expect(params.get('client_id')).toBe(config.clientId);
    expect(params.get('audience')).toBe('https://api.openai.com/v1');
    expect(params.get('redirect_uri')).toBe('https://platform.openai.com/auth/callback');
    expect(params.get('device_id')).toBe(envelope.deviceId);
    expect(params.get('screen_hint')).toBe('login_or_signup');
    expect(params.get('max_age')).toBe('0');
    expect(params.get('scope')).toBe('openid profile email offline_access');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('response_mode')).toBe('query');
    expect(params.get('state')).toBe(envelope.state);
    // Dotted, opaque, and random on BOTH halves (E2 §1.3 shape without a server session).
    expect(envelope.state).toMatch(/^[\da-f]{32}\.[\w-]{20,}$/);
    expect(params.get('nonce')).toBeTruthy();
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('auth0Client')).toBe(
      'eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9',
    );

    // The challenge must be the S256 hash of the verifier we carry in the envelope.
    expect(params.get('code_challenge')).toBe(
      createHash('sha256').update(envelope.verifier, 'ascii').digest('base64url'),
    );

    expect(result.userCode).toBe('');
    expect(result.interval).toBe(0);
    expect(result.expiresIn).toBe(600);
    expect(result.verificationUriComplete).toBe(result.verificationUri);
    // The envelope is client-held state, and must stay inside the contract bound.
    expect(result.deviceCode.length).toBeLessThan(8192);
  });

  it('rejects a card without the authorization-code endpoints', async () => {
    const service = new ChatGPTWebOAuthService();
    await expect(
      service.initiateDeviceCode({ ...config, authorizationCode: undefined }),
    ).rejects.toThrow(/not configured/);
  });
});

describe('parseCallbackInput', () => {
  it('accepts a full callback URL', () => {
    expect(
      parseCallbackInput('https://platform.openai.com/auth/callback?code=abc123&state=st'),
    ).toEqual({ code: 'abc123', fromUrl: true, state: 'st' });
  });

  it('accepts a bare code', () => {
    expect(parseCallbackInput('  abc123  ')).toEqual({ code: 'abc123', fromUrl: false });
  });

  it.each([
    ['empty', '   '],
    ['url without a code', 'https://platform.openai.com/auth/callback?error=access_denied'],
    ['garbage with a query separator', 'not a code?x=1'],
    ['unparseable url', 'https://['],
  ])('rejects %s', (_label, input) => {
    expect(() => parseCallbackInput(input)).toThrowError(
      expect.objectContaining({ code: 'invalid_callback' }),
    );
  });
});

describe('parsePasteEnvelope', () => {
  /** Exactly what `initiateDeviceCode` mints: uuid v4, 86-char base64url verifier, dotted state. */
  const envelope: ChatGPTWebPasteEnvelope = {
    createdAt: Date.now(),
    deviceId: '3f7c0f7a-6f6e-4a1b-9c2d-8e5a1b2c3d4e',
    state: `${'a1b2c3d4'.repeat(4)}.${'Zm9vYmFy_-abc'}`,
    v: 1,
    verifier: 'v'.repeat(86),
  };

  it('round-trips a valid envelope', () => {
    expect(parsePasteEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('accepts the envelope the service itself generates', async () => {
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: vi.fn() as unknown as typeof fetch,
    });
    const { deviceCode } = await service.initiateDeviceCode(config);

    expect(() => parsePasteEnvelope(deviceCode)).not.toThrow();
  });

  it('rejects malformed JSON and wrong shapes', () => {
    expect(() => parsePasteEnvelope('nope')).toThrowError(
      expect.objectContaining({ code: 'invalid_callback' }),
    );
    expect(() => parsePasteEnvelope(JSON.stringify({ v: 2 }))).toThrowError(
      expect.objectContaining({ code: 'invalid_callback' }),
    );
  });

  /**
   * Shape-only checks accepted `{verifier:"", state:"", deviceId:""}`: the empty device id
   * was then persisted and sent as `oai-device-id` on every later request, and an empty
   * verifier is no PKCE proof at all. Each field is validated against what we generate.
   */
  it.each([
    ['an empty device id', { deviceId: '' }],
    ['a non-uuid device id', { deviceId: 'device-1' }],
    ['a uuid of the wrong version', { deviceId: '3f7c0f7a-6f6e-1a1b-9c2d-8e5a1b2c3d4e' }],
    ['an empty verifier', { verifier: '' }],
    ['a too-short verifier', { verifier: 'v'.repeat(42) }],
    ['a too-long verifier', { verifier: 'v'.repeat(129) }],
    ['a verifier outside the PKCE charset', { verifier: `${'v'.repeat(85)}$` }],
    ['an empty state', { state: '' }],
    ['an undotted state', { state: 'nodothere' }],
    ['a state with an empty half', { state: 'abc.' }],
    ['a non-finite createdAt', { createdAt: Number.POSITIVE_INFINITY }],
    ['a NaN createdAt', { createdAt: Number.NaN }],
    ['a future createdAt beyond the clock skew', { createdAt: Date.now() + 5 * 60 * 1000 }],
  ])('rejects %s', (_label, patch) => {
    expect(() => parsePasteEnvelope(JSON.stringify({ ...envelope, ...patch }))).toThrowError(
      expect.objectContaining({ code: 'invalid_callback' }),
    );
  });

  it('tolerates a small forward clock skew', () => {
    const skewed = { ...envelope, createdAt: Date.now() + 30_000 };

    expect(parsePasteEnvelope(JSON.stringify(skewed))).toEqual(skewed);
  });

  it('rejects an expired envelope', () => {
    const stale = { ...envelope, createdAt: Date.now() - 11 * 60 * 1000 };
    expect(() => parsePasteEnvelope(JSON.stringify(stale))).toThrowError(
      expect.objectContaining({ code: 'expired' }),
    );
  });
});

describe('ChatGPTWebOAuthService.exchangeCallback', () => {
  let authFetch: ReturnType<typeof vi.fn>;
  let transportFetch: ReturnType<typeof vi.fn>;
  let service: ChatGPTWebOAuthService;
  let deviceCode: string;

  beforeEach(async () => {
    authFetch = vi.fn();
    transportFetch = vi.fn();
    service = new ChatGPTWebOAuthService({
      authFetch: authFetch as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    deviceCode = (await service.initiateDeviceCode(config)).deviceCode;
  });

  const state = () => (JSON.parse(deviceCode) as ChatGPTWebPasteEnvelope).state;

  it('exchanges the code and extracts identity from the id_token', async () => {
    authFetch.mockResolvedValue(
      jsonResponse({
        access_token: jwt({ exp: futureExp }),
        id_token: jwt({
          'email': 'user@example.com',
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' },
        }),
        refresh_token: 'refresh-1',
      }),
    );

    const connection = await service.exchangeCallback(
      config,
      deviceCode,
      `https://platform.openai.com/auth/callback?code=the-code&state=${state()}`,
    );

    expect(connection.accountId).toBe('acct-42');
    expect(connection.email).toBe('user@example.com');
    expect(connection.refreshToken).toBe('refresh-1');
    expect(connection.expiresAt).toBe(futureExp * 1000);
    expect(connection.deviceId).toBe((JSON.parse(deviceCode) as ChatGPTWebPasteEnvelope).deviceId);

    const [url, init] = authFetch.mock.calls[0];
    expect(url).toBe('https://auth.openai.com/api/accounts/oauth/token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      client_id: config.clientId,
      code: 'the-code',
      code_verifier: (JSON.parse(deviceCode) as ChatGPTWebPasteEnvelope).verifier,
      grant_type: 'authorization_code',
      redirect_uri: 'https://platform.openai.com/auth/callback',
    });
    expect(init.headers['auth0-client']).toBeTruthy();
    expect(init.headers['content-type']).toBe('application/json');
    // No identity probe needed when the id_token already carries email + account id.
    expect(transportFetch).not.toHaveBeenCalled();
  });

  /** E2 §1.4: the endpoint is served to the platform SPA, and it looks at all of these. */
  it('sends the documented exchange header set', async () => {
    authFetch.mockResolvedValue(
      jsonResponse({
        access_token: jwt({ email: 'user@example.com', exp: futureExp }),
        refresh_token: 'refresh-1',
      }),
    );

    await service.exchangeCallback(config, deviceCode, 'bare-code');

    const headers = authFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers).toMatchObject({
      'accept': 'application/json',
      'accept-language': PROFILE.acceptLanguage,
      'cache-control': 'no-cache',
      'origin': 'https://platform.openai.com',
      'priority': 'u=1, i',
      'referer': 'https://platform.openai.com/',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${PROFILE.platform}"`,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    });
    expect(headers.dnt).toBe(PROFILE.dnt ? '1' : undefined);
    expect(headers).not.toHaveProperty('connection');
    expect(headers).not.toHaveProperty('accept-encoding');
    expect(headers).not.toHaveProperty('sec-gpc');
    expect(headers['user-agent']).toBe(PROFILE.userAgent);
  });

  /**
   * A connection without a refresh grant reports `canRefresh: true` nowhere, but the
   * primary flow silently becoming non-renewable is worse: it works for ten days and then
   * dies mid-conversation with no signal at connect time.
   */
  it('refuses an exchange that returns no refresh_token', async () => {
    authFetch.mockResolvedValue(jsonResponse({ access_token: jwt({ exp: futureExp }) }));

    await expect(service.exchangeCallback(config, deviceCode, 'bare-code')).rejects.toThrowError(
      expect.objectContaining({ code: 'exchange_failed' }),
    );
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it('falls back to accounts/check through the impersonated transport', async () => {
    authFetch.mockResolvedValue(
      jsonResponse({
        access_token: jwt({ email: 'user@example.com', exp: futureExp }),
        refresh_token: 'refresh-1',
      }),
    );
    transportFetch.mockResolvedValue(
      jsonResponse({ accounts: { default: { account: { account_id: 'acct-probe' } } } }),
    );

    const connection = await service.exchangeCallback(config, deviceCode, 'bare-code');

    expect(connection.accountId).toBe('acct-probe');
    expect(
      transportFetch.mock.calls.some(([url]) =>
        String(url).includes('/backend-api/accounts/check/'),
      ),
    ).toBe(true);
  });

  it('reads the namespaced profile email claim from the access token', async () => {
    authFetch.mockResolvedValue(
      jsonResponse({
        access_token: jwt({
          'exp': futureExp,
          'https://api.openai.com/profile': { email: 'profile@example.com' },
        }),
        refresh_token: 'refresh-1',
      }),
    );
    transportFetch.mockResolvedValue(jsonResponse({}));

    const connection = await service.exchangeCallback(config, deviceCode, 'bare-code');

    expect(connection.email).toBe('profile@example.com');
    // The claim was enough; /backend-api/me is only for tokens that carry no email at all.
    expect(transportFetch.mock.calls.some(([url]) => String(url).endsWith('/backend-api/me'))).toBe(
      false,
    );
  });

  it('falls back to /backend-api/me when no token carries an email claim', async () => {
    authFetch.mockResolvedValue(
      jsonResponse({ access_token: jwt({ exp: futureExp }), refresh_token: 'refresh-1' }),
    );
    transportFetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/backend-api/me')
        ? jsonResponse({ email: 'me@example.com' })
        : jsonResponse({}),
    );

    const connection = await service.exchangeCallback(config, deviceCode, 'bare-code');

    expect(connection.email).toBe('me@example.com');
  });

  it('swallows a failing identity probe instead of losing the grant', async () => {
    authFetch.mockResolvedValue(
      jsonResponse({ access_token: jwt({ exp: futureExp }), refresh_token: 'refresh-1' }),
    );
    transportFetch.mockRejectedValue(new Error('transport down'));

    const connection = await service.exchangeCallback(config, deviceCode, 'bare-code');

    expect(connection.accessToken).toBeTruthy();
    expect(connection.accountId).toBeUndefined();
    expect(connection.email).toBeUndefined();
  });

  it('rejects a pasted callback URL that carries no state', async () => {
    await expect(
      service.exchangeCallback(
        config,
        deviceCode,
        'https://platform.openai.com/auth/callback?code=c',
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'state_mismatch' }));

    expect(authFetch).not.toHaveBeenCalled();
  });

  it('rejects a state mismatch before calling the token endpoint', async () => {
    await expect(
      service.exchangeCallback(
        config,
        deviceCode,
        'https://platform.openai.com/auth/callback?code=c&state=other',
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'state_mismatch' }));

    expect(authFetch).not.toHaveBeenCalled();
  });

  it('rejects an expired envelope before calling the token endpoint', async () => {
    const stale = JSON.parse(deviceCode) as ChatGPTWebPasteEnvelope;
    stale.createdAt = Date.now() - 11 * 60 * 1000;

    await expect(
      service.exchangeCallback(config, JSON.stringify(stale), 'code'),
    ).rejects.toThrowError(expect.objectContaining({ code: 'expired' }));
    expect(authFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an HTTP error', () => jsonResponse({ error: 'invalid_grant' }, 400)],
    ['a response without an access token', () => jsonResponse({ id_token: 'x' })],
  ])('maps %s to exchange_failed', async (_label, build) => {
    authFetch.mockResolvedValue(build());

    await expect(service.exchangeCallback(config, deviceCode, 'code')).rejects.toThrowError(
      expect.objectContaining({ code: 'exchange_failed' }),
    );
  });

  it('maps a network failure to exchange_failed', async () => {
    authFetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(service.exchangeCallback(config, deviceCode, 'code')).rejects.toBeInstanceOf(
      ChatGPTWebOAuthError,
    );
  });
});

describe('ChatGPTWebOAuthService.verifyAccessToken', () => {
  const build = (transportFetch: ReturnType<typeof vi.fn>) =>
    new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

  it('accepts a token /me answers and fills identity + expiry', async () => {
    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(jsonResponse({ email: 'me@example.com', id: 'user-1' }))
      .mockResolvedValueOnce(
        jsonResponse({ accounts: { default: { account: { id: 'acct-9' } } } }),
      );

    const connection = await build(transportFetch).verifyAccessToken(jwt({ exp: futureExp }));

    expect(connection.email).toBe('me@example.com');
    expect(connection.accountId).toBe('acct-9');
    expect(connection.expiresAt).toBe(futureExp * 1000);
    expect(connection.refreshToken).toBeUndefined();
    expect(connection.deviceId).toMatch(/^[\da-f-]{36}$/);

    const headers = transportFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${jwt({ exp: futureExp })}`);
    expect(headers['OAI-Device-Id']).toBe(connection.deviceId);
    expect(headers['OAI-Language']).toBe(PERSISTED_PROFILE.oaiLanguage);
    expect(headers['user-agent'] ?? headers['User-Agent']).toBe(PERSISTED_PROFILE.userAgent);
    expect(headers['Sec-Ch-Ua-Platform']).toBe(`"${PERSISTED_PROFILE.platform}"`);
    expect(headers['Sec-Fetch-User']).toBe('');
    expect(headers['Upgrade-Insecure-Requests']).toBe('');
    expect(headers[COOKIE_JAR_HEADER]).toBe(connection.deviceId);
    expect(headers['OAI-Session-Id']).toBe(deriveSessionId(connection.deviceId, PERSISTED_PROFILE));
    expect(headers).toEqual({
      ...buildChatGptWebXhrHeaders({
        accessToken: jwt({ exp: futureExp }),
        browserProfile: PERSISTED_PROFILE,
        deviceId: connection.deviceId,
        sessionId: headers['OAI-Session-Id'],
      }),
      [COOKIE_JAR_HEADER]: connection.deviceId,
    });
  });

  it('reuses a provided device id', async () => {
    const transportFetch = vi.fn().mockResolvedValue(jsonResponse({ email: 'me@example.com' }));

    const connection = await build(transportFetch).verifyAccessToken('token', 'device-fixed');

    expect(connection.deviceId).toBe('device-fixed');
  });

  it.each([
    ['a 401', () => jsonResponse({ detail: 'nope' }, 401)],
    ['a 403 challenge', () => new Response('<html>', { status: 403 })],
  ])('maps %s to access_token_invalid', async (_label, buildResponse) => {
    const transportFetch = vi.fn().mockResolvedValue(buildResponse());

    await expect(build(transportFetch).verifyAccessToken('token')).rejects.toThrowError(
      expect.objectContaining({ code: 'access_token_invalid' }),
    );
  });

  it('rejects an empty token without a network call', async () => {
    const transportFetch = vi.fn();

    await expect(build(transportFetch).verifyAccessToken('   ')).rejects.toThrowError(
      expect.objectContaining({ code: 'access_token_invalid' }),
    );
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it('leaves the previous jar intact when access-token verify fails', async () => {
    const deviceId = 'device-keep-access-jar';
    const path = seedChatGPTWebSessionJar(deviceId, 'old-session');
    seedCookieJar(path, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);

    const transportFetch = vi.fn().mockResolvedValue(jsonResponse({ detail: 'nope' }, 401));

    await expect(build(transportFetch).verifyAccessToken('token', deviceId)).rejects.toThrowError(
      expect.objectContaining({ code: 'access_token_invalid' }),
    );

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('_cfuvid\tcf-live');
  });

  it('does not touch the live context jar while verifying a candidate access token', async () => {
    const accountId = 'user:alice:_:chatgptweb';
    const deviceId = 'device-keep-live-verify';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId,
    })!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedChatGPTWebSessionJar(live.cookieJarKey, 'old-session', undefined, deviceId);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);

    const assertLiveUntouched = () => {
      const contents = readFileSync(livePath, 'utf8');
      expect(contents).toContain('old-session');
      expect(contents).toContain('_cfuvid\tcf-live');
    };

    const transportFetch = vi.fn().mockImplementation(async () => {
      assertLiveUntouched();
      return jsonResponse({ detail: 'nope' }, 401);
    });

    await expect(
      new ChatGPTWebOAuthService({
        authFetch: vi.fn() as unknown as typeof fetch,
        browserProfile: PERSISTED_PROFILE,
        browserSessionAccountId: accountId,
        transportFetch: transportFetch as unknown as typeof fetch,
      }).verifyAccessToken('token', deviceId),
    ).rejects.toThrowError(expect.objectContaining({ code: 'access_token_invalid' }));

    assertLiveUntouched();
    expect(
      (transportFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers[
        COOKIE_JAR_HEADER
      ],
    ).not.toBe(live.cookieJarKey);
  });

  it('rejects a 200 /me body that is not JSON and does not commit the staged session', async () => {
    const accountId = 'user:alice:_:chatgptweb';
    const deviceId = 'device-keep-live-malformed-me';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId,
    })!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedChatGPTWebSessionJar(live.cookieJarKey, 'old-session', undefined, deviceId);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);

    const transportFetch = vi
      .fn()
      .mockResolvedValue(new Response('<html>challenge</html>', { status: 200 }));

    await expect(
      new ChatGPTWebOAuthService({
        authFetch: vi.fn() as unknown as typeof fetch,
        browserProfile: PERSISTED_PROFILE,
        browserSessionAccountId: accountId,
        transportFetch: transportFetch as unknown as typeof fetch,
      }).verifyAccessToken('token', deviceId),
    ).rejects.toThrowError(expect.objectContaining({ code: 'access_token_invalid' }));

    expect(getBrowserSessionRegistry().get(live.contextId)?.lifecycle).toBe('active');
    const contents = readFileSync(livePath, 'utf8');
    expect(contents).toContain('old-session');
    expect(contents).toContain('_cfuvid\tcf-live');
  });

  it('keeps the newly committed context live after a device-changing reconnect cleanup', async () => {
    const accountId = 'user:alice:_:chatgptweb';
    const oldDevice = 'device-old-reconnect';
    const newDevice = 'device-new-reconnect';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId: oldDevice,
    })!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);
    const oldPage = live.logicalPageId;

    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(jsonResponse({ email: 'me@example.com' }))
      .mockResolvedValueOnce(
        jsonResponse({ accounts: { default: { account: { id: 'acct-9' } } } }),
      );

    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      browserSessionAccountId: accountId,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    const connection = await service.verifyAccessToken(jwt({ exp: futureExp }), newDevice);
    // Promotion is the persist-success step, not a side effect of verify.
    service.commitVerifiedChatGPTWebSession(connection.deviceId);

    expect(connection.deviceId).toBe(newDevice);

    // Routers used to wipe by account identity here, which dropped the context
    // rotate had just committed. Only the leftover device-id jar is safe to drop.
    wipeChatGPTWebCookieJar(oldDevice);

    const stillLive = getBrowserSessionRegistry().getForIdentity({
      accountId,
      origin: 'https://chatgpt.com',
      provider: 'chatgptweb',
    });
    expect(stillLive?.lifecycle).toBe('active');
    expect(stillLive?.logicalPageId).toBeTruthy();
    expect(stillLive?.logicalPageId).not.toBe(oldPage);
    expect(
      readBrowserCookieJar(stillLive!.cookieJar.path).some(
        (cookie) => cookie.name === '_cfuvid' && cookie.value === 'cf-live',
      ),
    ).toBe(true);
  });

  it('does not promote the staged session until persist succeeds', async () => {
    const accountId = 'user:alice:_:chatgptweb';
    const deviceId = 'device-persist-order';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId,
    })!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedChatGPTWebSessionJar(live.cookieJarKey, 'old-session', undefined, deviceId);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);
    const liveId = live.contextId;

    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(jsonResponse({ email: 'me@example.com' }))
      .mockResolvedValueOnce(
        jsonResponse({ accounts: { default: { account: { id: 'acct-9' } } } }),
      );

    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      browserSessionAccountId: accountId,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    const connection = await service.verifyAccessToken(jwt({ exp: futureExp }), deviceId);

    // Verify succeeded; persist has not. Live jar must still be the old account.
    expect(getBrowserSessionRegistry().get(liveId)?.lifecycle).toBe('active');
    expect(readFileSync(livePath, 'utf8')).toContain('old-session');
    expect(readFileSync(livePath, 'utf8')).toContain('_cfuvid\tcf-live');
    expect(readFileSync(livePath, 'utf8')).not.toContain(connection.accessToken);

    // Persist failed: discard the staged candidate, leave live untouched.
    service.discardVerifiedChatGPTWebSession();
    expect(getBrowserSessionRegistry().get(liveId)?.lifecycle).toBe('active');
    expect(readFileSync(livePath, 'utf8')).toContain('old-session');
    expect(readFileSync(livePath, 'utf8')).toContain('_cfuvid\tcf-live');
  });

  it('promotes the staged session to live only after persist success', async () => {
    const accountId = 'user:alice:_:chatgptweb';
    const deviceId = 'device-persist-commit';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId,
    })!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedChatGPTWebSessionJar(live.cookieJarKey, 'old-session', undefined, deviceId);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);

    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(
        sessionResponse(
          { accessToken: jwt({ exp: futureExp }) },
          { setCookie: [`${SESSION_COOKIE}=new-session; Path=/`] },
        ),
      )
      .mockResolvedValue(jsonResponse({ email: 'me@example.com' }));

    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      browserSessionAccountId: accountId,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    const connection = await service.connectWithSession(SESSION_JWE, deviceId);

    expect(readFileSync(livePath, 'utf8')).toContain('old-session');
    expect(readFileSync(livePath, 'utf8')).not.toContain('new-session');

    service.commitVerifiedChatGPTWebSession(connection.deviceId);

    const committed = getBrowserSessionRegistry().getForIdentity({
      accountId,
      origin: 'https://chatgpt.com',
      provider: 'chatgptweb',
    });
    expect(committed?.lifecycle).toBe('active');
    const committedPath = committed
      ? resolveCookieJarPath(`ctx:${committed.cookieJar.digest}`)
      : livePath;
    expect(readFileSync(committedPath, 'utf8')).toContain('new-session');
    expect(readFileSync(committedPath, 'utf8')).not.toContain('old-session');
  });
});

describe('sessionHeaders / webSessionHeaders identity', () => {
  it('sessionHeaders deep-equals the runtime XHR builder for the same inputs', () => {
    expect(sessionHeaders('tok', 'dev-1', 'sess-1')).toEqual(
      buildChatGptWebXhrHeaders({
        accessToken: 'tok',
        deviceId: 'dev-1',
        sessionId: 'sess-1',
      }),
    );
  });

  it('sends no cookie jar while degraded onto the bundled fallback identity', async () => {
    // cf_clearance is UA-bound: replaying the persisted identity's jar behind the
    // fallback UA/TLS profile is what provokes the Cloudflare challenge.
    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(jsonResponse({ email: 'me@example.com' }))
      .mockResolvedValueOnce(
        jsonResponse({ accounts: { default: { account: { id: 'acct-9' } } } }),
      );

    await new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: DEFAULT_BROWSER_DEVICE_PROFILE,
      transportFetch: transportFetch as unknown as typeof fetch,
    }).verifyAccessToken(jwt({ exp: futureExp }), 'device-stable');

    for (const call of transportFetch.mock.calls) {
      const init = call[1] as { headers: Record<string, string> };
      expect(init.headers[COOKIE_JAR_HEADER]).toBeUndefined();
    }
  });

  it('defaults OAI-Session-Id to the device-derived uuid', () => {
    expect(sessionHeaders('tok', 'dev-1')['OAI-Session-Id']).toBe(deriveSessionId('dev-1'));
  });

  it('consecutive /me and accounts-check probes for one device share OAI-Session-Id', async () => {
    const deviceId = 'device-stable';
    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ email: 'me@example.com' }))
      .mockResolvedValueOnce(
        jsonResponse({ accounts: { default: { account: { id: 'acct-9' } } } }),
      );

    await new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      transportFetch: transportFetch as unknown as typeof fetch,
    }).verifyAccessToken(jwt({ exp: futureExp }), deviceId);

    const sessionIds = transportFetch.mock.calls.map((call) => {
      const init = call[1] as { headers: Record<string, string> };
      return init.headers['OAI-Session-Id'];
    });
    expect(sessionIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sessionIds)).toEqual(new Set([deriveSessionId(deviceId, PERSISTED_PROFILE)]));
  });

  it('keys the jar and page session by account identity, not the shared device id', async () => {
    const deviceId = 'device-shared';
    const seen: Array<{ jar: string | undefined; session: string | undefined }> = [];
    const probe = (accountId: string) => {
      const transportFetch = vi.fn();
      transportFetch
        .mockResolvedValueOnce(jsonResponse({ email: 'me@example.com' }))
        .mockResolvedValueOnce(
          jsonResponse({ accounts: { default: { account: { id: 'acct-9' } } } }),
        );
      return new ChatGPTWebOAuthService({
        authFetch: vi.fn() as unknown as typeof fetch,
        browserProfile: PERSISTED_PROFILE,
        browserSessionAccountId: accountId,
        transportFetch: transportFetch as unknown as typeof fetch,
      })
        .verifyAccessToken(jwt({ exp: futureExp }), deviceId)
        .then(() => {
          for (const call of transportFetch.mock.calls) {
            const headers = (call[1] as { headers: Record<string, string> }).headers;
            seen.push({ jar: headers[COOKIE_JAR_HEADER], session: headers['OAI-Session-Id'] });
          }
        });
    };

    await probe('user:alice:_:chatgptweb');
    await probe('user:bob:_:chatgptweb');

    expect(seen.length).toBeGreaterThanOrEqual(4);
    const alice = seen[0]!;
    const bob = seen[seen.length / 2]!;
    expect(alice.jar).toBeTruthy();
    expect(bob.jar).toBeTruthy();
    expect(alice.jar).not.toBe(deviceId);
    expect(bob.jar).not.toBe(deviceId);
    expect(alice.jar).not.toBe(bob.jar);
    expect(alice.session).not.toBe(bob.session);
    expect(alice.session).not.toBe(deriveSessionId(deviceId, PERSISTED_PROFILE));
  });
});

describe('ChatGPTWebOAuthService.refreshAccessToken', () => {
  const build = (authFetch: ReturnType<typeof vi.fn>) =>
    new ChatGPTWebOAuthService({ authFetch: authFetch as unknown as typeof fetch });

  it('sends the form-encoded grant with the platform UA and a bounded signal', async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: 'new-access', refresh_token: 'rotated' }));

    const tokens = await build(authFetch).refreshAccessToken(config, 'old-refresh');

    expect(tokens.accessToken).toBe('new-access');
    expect(tokens.refreshToken).toBe('rotated');

    const [url, init] = authFetch.mock.calls[0];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers['user-agent']).toBe(PROFILE.userAgent);
    expect(init.headers['sec-ch-ua-platform']).toBe(`"${PROFILE.platform}"`);
    expect(init.headers['accept-language']).toBe(PROFILE.acceptLanguage);
    expect(init.headers).not.toHaveProperty('connection');
    expect(init.headers).not.toHaveProperty('sec-gpc');
    expect(init.headers).not.toHaveProperty('accept-encoding');
    // A hung token endpoint must not pin the shared refresh lease indefinitely.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      client_id: config.clientId,
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
    });
  });

  it('keeps the old refresh token when the provider does not rotate', async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'new-access' }));

    const tokens = await build(authFetch).refreshAccessToken(config, 'old-refresh');

    expect(tokens.refreshToken).toBe('old-refresh');
  });

  it('raises OAuthInvalidGrantError on a dead grant', async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(build(authFetch).refreshAccessToken(config, 'dead')).rejects.toMatchObject({
      name: 'OAuthInvalidGrantError',
    });
  });

  it('never copies provider prose into the failure message', async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'server_error', error_description: 'token 12345 for user@example.com' },
          500,
        ),
      );

    await expect(build(authFetch).refreshAccessToken(config, 'x')).rejects.toThrow(
      /^Failed to refresh access token: 500 server_error$/,
    );
  });

  it('renews through the web session when the stored kind says so', async () => {
    const authFetch = vi.fn();
    const transportFetch = vi
      .fn()
      .mockResolvedValue(sessionResponse({ accessToken: jwt({ exp: futureExp }) }));
    const service = new ChatGPTWebOAuthService({
      authFetch: authFetch as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    const tokens = await service.refreshAccessToken(config, SESSION_JWE, {
      renewalKind: 'web_session',
    });

    expect(tokens.accessToken).toBe(jwt({ exp: futureExp }));
    // No rotation offered: the presented session is still the one to store.
    expect(tokens.refreshToken).toBe(SESSION_JWE);
    expect(tokens.expiresIn).toBeGreaterThan(0);
    // The OAuth token endpoint is never touched on this path.
    expect(authFetch).not.toHaveBeenCalled();
    expect(String(transportFetch.mock.calls[0][0])).toBe('https://chatgpt.com/api/auth/session');
  });

  it('identifies a session credential by shape when no kind was stored', async () => {
    const transportFetch = vi.fn().mockResolvedValue(sessionResponse({ accessToken: 'minted' }));
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    const tokens = await service.refreshAccessToken(config, SESSION_JWE);

    expect(tokens.accessToken).toBe('minted');
  });

  it('stores the rotated session cookie, never the consumed one', async () => {
    const transportFetch = vi
      .fn()
      .mockResolvedValue(
        sessionResponse(
          { accessToken: 'minted' },
          { setCookie: [`${SESSION_COOKIE}=rotated-jwe`] },
        ),
      );
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    const tokens = await service.refreshAccessToken(config, SESSION_JWE, {
      renewalKind: 'web_session',
    });

    expect(tokens.refreshToken).toBe('rotated-jwe');
  });

  it('treats a dead session as invalid_grant so the pipeline can self-heal and report it', async () => {
    const transportFetch = vi.fn().mockResolvedValue(jsonResponse({}));
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    await expect(
      service.refreshAccessToken(config, SESSION_JWE, { renewalKind: 'web_session' }),
    ).rejects.toMatchObject({ name: 'OAuthInvalidGrantError' });
  });

  it('keeps a Cloudflare challenge transient instead of killing the credential', async () => {
    const transportFetch = vi.fn().mockImplementation(async () => challengeResponse());
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    const error = await withFakeTimers(() =>
      service
        .refreshAccessToken(config, SESSION_JWE, { renewalKind: 'web_session' })
        .catch((thrown: unknown) => thrown),
    );

    expect(error).toBeInstanceOf(Error);
    // NOT invalid_grant: the 5-minute backoff retries this, a dead grant would not.
    expect((error as Error).name).not.toBe('OAuthInvalidGrantError');
    expect((error as Error).message).toBe('ChatGPT Web session request failed: 403');
    // One attempt fewer than connect: this call has to fit inside the shared refresh lease.
    expect(transportFetch).toHaveBeenCalledTimes(3);
  });

  it('rides out a challenge and renews on a later attempt', async () => {
    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(sessionResponse({ accessToken: 'minted' }));
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    const tokens = await withFakeTimers(() =>
      service.refreshAccessToken(config, SESSION_JWE, { renewalKind: 'web_session' }),
    );

    expect(tokens.accessToken).toBe('minted');
    expect(transportFetch).toHaveBeenCalledTimes(2);
  });

  /**
   * Connect sends `oai-did`; a renewal that omitted it looked like a brand-new device on
   * every call — to the one host whose bot filter is the reason this path needs an
   * impersonating transport at all. The id travels from the vault through
   * `OAuthRefreshOptions`.
   */
  it('presents the stored device id on a session renewal, exactly as connect did', async () => {
    const transportFetch = vi.fn().mockResolvedValue(sessionResponse({ accessToken: 'minted' }));
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    await service.refreshAccessToken(config, SESSION_JWE, {
      deviceId: 'a3f7c0f7-6f6e-4a1b-9c2d-8e5a1b2c3d4e',
      renewalKind: 'web_session',
    });

    expect(sessionCookieOf(transportFetch)).toBe(
      `oai-did=a3f7c0f7-6f6e-4a1b-9c2d-8e5a1b2c3d4e; ${SESSION_COOKIE}=${SESSION_JWE}`,
    );
  });

  /** The device id is durable state an admin credential edit can write — into a Cookie header. */
  it('drops a stored device id that could inject cookies, instead of sending it', async () => {
    const transportFetch = vi.fn().mockResolvedValue(sessionResponse({ accessToken: 'minted' }));
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    await service.refreshAccessToken(config, SESSION_JWE, {
      deviceId: 'dev; __Secure-next-auth.session-token=attacker',
      renewalKind: 'web_session',
    });

    expect(sessionCookieOf(transportFetch)).toBe(`${SESSION_COOKIE}=${SESSION_JWE}`);
  });

  /**
   * A stored credential that cannot be presented is terminal, and `invalid_grant` is the
   * right shape of terminal: it makes the pipeline re-read durable state (a concurrent
   * reconnect may have replaced the leaf) before demanding a reconnect.
   */
  it('refuses to spend a stored session credential that is not a usable cookie value', async () => {
    const transportFetch = vi.fn();
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    await expect(
      service.refreshAccessToken(config, 'jwe; injected=1', { renewalKind: 'web_session' }),
    ).rejects.toMatchObject({ name: 'OAuthInvalidGrantError' });
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it('stops retrying the moment the caller deadline is spent', async () => {
    const caller = new AbortController();
    const transportFetch = vi.fn().mockImplementation(async () => {
      // The lease budget runs out mid-flight, exactly as a slow challenge would spend it.
      caller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

    const error = await service
      .refreshAccessToken(config, SESSION_JWE, {
        renewalKind: 'web_session',
        signal: caller.signal,
      })
      .catch((thrown: unknown) => thrown);

    expect((error as Error).message).toBe('ChatGPT Web session request failed: AbortError');
    // Retrying past the caller's bound is what would outlive the shared refresh lease.
    expect(transportFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Rotation is where a session connection is won or lost: next-auth invalidates the value we
 * presented the moment it hands back a new one, so a rotation that is missed — or read
 * HALFWAY — leaves the vault holding a credential the upstream has already thrown away.
 */
describe('rotated session cookie', () => {
  const renew = async (response: Response, presented = SESSION_JWE) => {
    const transportFetch = vi.fn().mockResolvedValue(response);
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    const tokens = await service.refreshAccessToken(config, presented, {
      renewalKind: 'web_session',
    });
    return tokens.refreshToken;
  };

  /**
   * The chunked form appears whenever the JWE outgrows one cookie — i.e. on exactly the
   * large, long-lived sessions worth connecting. Reading only `.0` would persist a truncated
   * value while the presented one is already consumed: an unrecoverable connection.
   */
  it('re-assembles a chunked rotation in index order, whatever order the headers arrive in', async () => {
    const stored = await renew(
      sessionResponse(
        { accessToken: 'minted' },
        {
          setCookie: [
            `${SESSION_COOKIE}.1=second-half; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT`,
            `${SESSION_COOKIE}.0=first-half; Path=/; HttpOnly; Secure`,
          ],
        },
      ),
    );

    expect(stored).toBe('first-halfsecond-half');
  });

  /** Switching chunked→plain: next-auth sets the plain cookie and expires every chunk. */
  it('ignores the stale-chunk cleanup headers next-auth sends beside a plain rotation', async () => {
    const stored = await renew(
      sessionResponse(
        { accessToken: 'minted' },
        {
          setCookie: [
            `${SESSION_COOKIE}=rotated-plain; Path=/; HttpOnly`,
            `${SESSION_COOKIE}.0=; Path=/; Max-Age=0`,
            `${SESSION_COOKIE}.1=; Path=/; Max-Age=0`,
          ],
        },
      ),
    );

    expect(stored).toBe('rotated-plain');
  });

  /** Switching plain→chunked: the assembled chunks are the rotation, not the cleared cookie. */
  it('prefers the chunked rotation over the plain cookie being cleared in the same response', async () => {
    const stored = await renew(
      sessionResponse(
        { accessToken: 'minted' },
        {
          setCookie: [
            `${SESSION_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
            `${SESSION_COOKIE}.0=aaa; Path=/`,
            `${SESSION_COOKIE}.1=bbb; Path=/`,
            `${SESSION_COOKIE}.2=ccc; Path=/`,
          ],
        },
      ),
    );

    expect(stored).toBe('aaabbbccc');
  });

  /**
   * Keeping the presented value risks a 401 the reconnect path already handles; persisting a
   * partial join guarantees a dead credential with nothing to see it by.
   */
  it('discards a chunk set with a gap rather than persisting a partial join', async () => {
    const stored = await renew(
      sessionResponse(
        { accessToken: 'minted' },
        { setCookie: [`${SESSION_COOKIE}.0=aaa`, `${SESSION_COOKIE}.2=ccc`] },
      ),
    );

    expect(stored).toBe(SESSION_JWE);
  });

  it('discards a rotated value that is not a usable cookie value', async () => {
    const stored = await renew(
      sessionResponse({ accessToken: 'minted' }, { setCookie: [`${SESSION_COOKIE}=rot=ated`] }),
    );

    expect(stored).toBe(SESSION_JWE);
  });

  it('keeps the presented session when the rotation is a deletion', async () => {
    const stored = await renew(
      sessionResponse({ accessToken: 'minted' }, { setCookie: [`${SESSION_COOKIE}=; Max-Age=0`] }),
    );

    expect(stored).toBe(SESSION_JWE);
  });
});

/**
 * A body that cannot be READ is not an answer about the session. Collapsing it into `{}` made
 * a dropped connection indistinguishable from "this session mints nothing" — i.e. terminal,
 * which kills a shared credential every user depends on because of a network blip.
 */
describe('unreadable session response', () => {
  const build = (transportFetch: ReturnType<typeof vi.fn>) =>
    new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

  it('is transient on refresh — retried, never invalid_grant', async () => {
    const transportFetch = vi.fn().mockImplementation(async () => unreadableBodyResponse());

    const error = await withFakeTimers(() =>
      build(transportFetch)
        .refreshAccessToken(config, SESSION_JWE, { renewalKind: 'web_session' })
        .catch((thrown: unknown) => thrown),
    );

    expect((error as Error).name).not.toBe('OAuthInvalidGrantError');
    expect((error as Error).message).toBe('ChatGPT Web session response could not be read');
    expect(transportFetch).toHaveBeenCalledTimes(3);
  });

  it('is transient on connect — never reported as an expired session', async () => {
    const transportFetch = vi.fn().mockImplementation(async () => unreadableBodyResponse());

    const error = await withFakeTimers(() =>
      build(transportFetch)
        .connectWithSession(SESSION_JWE)
        .catch((thrown: unknown) => thrown),
    );

    expect(error).not.toBeInstanceOf(ChatGPTWebOAuthError);
    expect(transportFetch).toHaveBeenCalledTimes(4);
  });

  /**
   * The upstream can rotate the cookie and STILL fail to deliver the body. From that moment
   * the value we presented is dead, so retrying it would burn every remaining attempt on a
   * credential that can only 401.
   */
  it('retries with the rotation the failed attempt already received', async () => {
    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(unreadableBodyResponse([`${SESSION_COOKIE}=rotated-mid-flight`]))
      .mockResolvedValueOnce(sessionResponse({ accessToken: 'minted' }));

    const tokens = await withFakeTimers(() =>
      build(transportFetch).refreshAccessToken(config, SESSION_JWE, { renewalKind: 'web_session' }),
    );

    expect(sessionCookieOf(transportFetch, 1)).toBe(`${SESSION_COOKIE}=rotated-mid-flight`);
    // And the rotation is what gets stored — the presented value is gone upstream.
    expect(tokens.refreshToken).toBe('rotated-mid-flight');
    expect(tokens.accessToken).toBe('minted');
  });
});

describe('ChatGPTWebOAuthService.connectWithSession', () => {
  const build = (transportFetch: ReturnType<typeof vi.fn>) =>
    new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

  it('mints an access token from the session and stores the session as the renewal credential', async () => {
    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(
        sessionResponse(
          {
            accessToken: jwt({ exp: futureExp }),
            expires: '2026-12-01T00:00:00.000Z',
            user: { email: 'ops@example.com', id: 'user-1' },
          },
          {
            setCookie: [
              `${SESSION_COOKIE}=rotated-jwe; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT`,
            ],
          },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ accounts: { default: { account: { id: 'acct-9' } } } }),
      );

    const connection = await build(transportFetch).connectWithSession(SESSION_JWE, 'device-fixed');

    expect(connection.accessToken).toBe(jwt({ exp: futureExp }));
    // The ROTATED cookie: presenting the consumed one would 401 at the next renewal.
    expect(connection.refreshToken).toBe('rotated-jwe');
    expect(connection.renewalKind).toBe('web_session');
    expect(connection.email).toBe('ops@example.com');
    expect(connection.accountId).toBe('acct-9');
    expect(connection.expiresAt).toBe(futureExp * 1000);
    expect(connection.sessionExpiresAt).toBe(Date.parse('2026-12-01T00:00:00.000Z'));
    expect(connection.deviceId).toBe('device-fixed');

    const sessionCall = transportFetch.mock.calls.find((call) =>
      String(call[0]).endsWith('/api/auth/session'),
    );
    expect(sessionCall).toBeDefined();
    const sessionHdrs = sessionCall![1].headers as Record<string, string>;
    expect(sessionHdrs.origin).toBe('https://chatgpt.com');
    expect(sessionHdrs['sec-fetch-site']).toBe('same-origin');
    expect(sessionHdrs['sec-fetch-mode']).toBe('cors');
    expect(sessionHdrs['sec-fetch-dest']).toBe('empty');
    expect(sessionHdrs['sec-ch-ua-platform']).toBe(`"${PERSISTED_PROFILE.platform}"`);
    expect(sessionHdrs.priority).toBe('u=1, i');
    expect(sessionHdrs.dnt).toBe(PERSISTED_PROFILE.dnt ? '1' : undefined);
    expect(sessionHdrs['Sec-Fetch-User']).toBe('');
    expect(sessionHdrs['Upgrade-Insecure-Requests']).toBe('');
    expect(sessionHdrs['user-agent']).toBe(PERSISTED_PROFILE.userAgent);
    expect(sessionHdrs['accept-language']).toBe(PERSISTED_PROFILE.acceptLanguage);
    expect(sessionHdrs[COOKIE_JAR_HEADER]).toBe('device-fixed');

    const [url, init] = transportFetch.mock.calls[0];
    expect(String(url)).toBe('https://chatgpt.com/api/auth/session');
    // The session travels as a COOKIE, exactly as the browser sends it.
    expect(init.headers.cookie).toBe(`oai-did=device-fixed; ${SESSION_COOKIE}=${SESSION_JWE}`);
    expect(init.headers.referer).toBe('https://chatgpt.com/');
  });

  it('keeps the presented session when the response rotates nothing', async () => {
    const transportFetch = vi
      .fn()
      .mockResolvedValue(sessionResponse({ accessToken: jwt({ exp: futureExp }) }));

    const connection = await build(transportFetch).connectWithSession(SESSION_JWE);

    expect(connection.refreshToken).toBe(SESSION_JWE);
  });

  it.each([
    ['an empty body', () => jsonResponse({})],
    ['the unauthenticated warning banner', () => jsonResponse({ WARNING_BANNER: 'do not paste' })],
    ['a 401', () => jsonResponse({ detail: 'nope' }, 401)],
  ])('rejects %s as session_invalid, WITHOUT retrying', async (_label, buildResponse) => {
    const transportFetch = vi.fn().mockResolvedValue(buildResponse());

    await expect(build(transportFetch).connectWithSession(SESSION_JWE)).rejects.toThrowError(
      expect.objectContaining({ code: 'session_invalid' }),
    );
    // A dead session answers every attempt the same way: retrying only burns the budget.
    expect(transportFetch).toHaveBeenCalledTimes(1);
  });

  it('rides out Cloudflare challenges and succeeds on a later attempt', async () => {
    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(sessionResponse({ accessToken: jwt({ exp: futureExp }) }));

    const connection = await withFakeTimers(() =>
      build(transportFetch).connectWithSession(SESSION_JWE),
    );

    expect(connection).toMatchObject({ accessToken: jwt({ exp: futureExp }) });
    // Three session calls; the identity probes that follow are separate.
    expect(
      transportFetch.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/session')),
    ).toHaveLength(3);
  });

  it.each([
    ['a Cloudflare challenge', () => challengeResponse()],
    ['a rate limit', () => new Response('<html>', { status: 429 })],
    ['an upstream 5xx', () => new Response('<html>', { status: 503 })],
  ])('surfaces %s as transient once the attempts run out', async (_label, buildResponse) => {
    const transportFetch = vi.fn().mockImplementation(async () => buildResponse());

    const error = await withFakeTimers(() =>
      build(transportFetch)
        .connectWithSession(SESSION_JWE)
        .catch((thrown: unknown) => thrown),
    );

    // Transient, NEVER a dead session: a challenged credential still works.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChatGPTWebOAuthError);
    expect((error as Error).message).toMatch(/^ChatGPT Web session request failed: \d+$/);
    expect(transportFetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry a status no later attempt could survive', async () => {
    const transportFetch = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));

    const error = await build(transportFetch)
      .connectWithSession(SESSION_JWE)
      .catch((thrown: unknown) => thrown);

    expect((error as Error).message).toBe('ChatGPT Web session request failed: 404');
    expect(transportFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty session without a network call', async () => {
    const transportFetch = vi.fn();

    await expect(build(transportFetch).connectWithSession('  ')).rejects.toThrowError(
      expect.objectContaining({ code: 'session_invalid' }),
    );
    expect(transportFetch).not.toHaveBeenCalled();
  });

  /**
   * The pasted value is interpolated into a `Cookie:` request header, which is a delimiter
   * format: a `;`, `,`, `=`, whitespace or control character in it would let whoever pasted it
   * append or overwrite cookies on a request this server makes with a shared credential.
   */
  it.each([
    ['a cookie separator', 'jwe; oai-did=attacker'],
    ['a cookie pair separator', 'jwe,other=1'],
    ['an assignment', 'jwe=attacker'],
    ['a CRLF header break', 'jwe\r\nX-Injected: 1'],
    ['whitespace', 'jwe attacker'],
    ['a control character', 'jwe\u0001attacker'],
    ['only separators', '...'],
  ])('rejects %s in a pasted session, without a network call', async (_label, pasted) => {
    const transportFetch = vi.fn();

    await expect(build(transportFetch).connectWithSession(pasted)).rejects.toThrowError(
      expect.objectContaining({ code: 'session_invalid' }),
    );
    expect(transportFetch).not.toHaveBeenCalled();
  });

  /**
   * The mint's budget used to be the only bound, while the identity probes that follow could
   * add ~30 s more on top of it — so a wedged upstream held an operator's "connect" click for
   * nearly a minute. One deadline now covers the whole connect.
   */
  it('bounds the identity probes by the same deadline as the session call', async () => {
    const budget = new AbortController();
    // The connect budget is the FIRST timeout the flow creates; everything after it is real.
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementationOnce(() => budget.signal as AbortSignal);
    const transportFetch = vi.fn();
    transportFetch
      .mockImplementationOnce(async () => {
        // The budget is spent by the time the mint returns — as a slow upstream would spend it.
        budget.abort();
        return sessionResponse({ accessToken: jwt({ exp: futureExp }) });
      })
      .mockResolvedValue(jsonResponse({ email: 'me@example.com' }));

    try {
      await build(transportFetch).connectWithSession(SESSION_JWE);
    } finally {
      timeoutSpy.mockRestore();
    }

    const probeCalls = transportFetch.mock.calls.filter(
      ([url]) => !String(url).endsWith('/api/auth/session'),
    );
    expect(probeCalls.length).toBeGreaterThan(0);
    // Already aborted: the probe inherited the connect deadline instead of starting a fresh one.
    for (const [, init] of probeCalls) expect(init.signal.aborted).toBe(true);
  });

  it('sends a two-chunk paste as two cookies and stores the logical token', async () => {
    const transportFetch = vi
      .fn()
      .mockResolvedValue(sessionResponse({ accessToken: jwt({ exp: futureExp }) }));
    const chunks = ['AAA', 'BBB'];

    const connection = await build(transportFetch).connectWithSession('AAABBB', 'device-chunks', {
      sessionChunks: chunks,
    });

    expect(connection.refreshToken).toBe('AAABBB');
    expect(connection.deviceId).toBe('device-chunks');
    expect(sessionCookieOf(transportFetch)).toBe(
      `oai-did=device-chunks; ${SESSION_COOKIE}.0=AAA; ${SESSION_COOKIE}.1=BBB`,
    );
    expect(readMatchingSessionChunksFromJar('device-chunks', 'AAABBB')).toEqual(chunks);
  });

  it('clears stale chunks when a later rotation is a single unchunked cookie', async () => {
    const transportFetch = vi.fn();
    transportFetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/api/auth/session')
        ? sessionResponse(
            { accessToken: jwt({ exp: futureExp }) },
            transportFetch.mock.calls.filter(([callUrl]) =>
              String(callUrl).endsWith('/api/auth/session'),
            ).length > 1
              ? { setCookie: [`${SESSION_COOKIE}=rotated-plain; Path=/`] }
              : {},
          )
        : jsonResponse({}),
    );

    const service = build(transportFetch);
    await service.connectWithSession('AAABBB', 'device-rotate', { sessionChunks: ['AAA', 'BBB'] });
    const tokens = await service.refreshAccessToken(config, 'AAABBB', {
      deviceId: 'device-rotate',
      renewalKind: 'web_session',
    });

    expect(tokens.refreshToken).toBe('rotated-plain');
    // Refresh still presented the original two chunks; the jar then replaced them.
    expect(sessionCookieOf(transportFetch, 1)).toBe(
      `oai-did=device-rotate; ${SESSION_COOKIE}.0=AAA; ${SESSION_COOKIE}.1=BBB`,
    );
    expect(readMatchingSessionChunksFromJar('device-rotate', 'rotated-plain')).toEqual([
      'rotated-plain',
    ]);
  });

  it('does not mint a new device id when the caller already has one', async () => {
    const transportFetch = vi
      .fn()
      .mockImplementation(async () => sessionResponse({ accessToken: jwt({ exp: futureExp }) }));

    const first = await build(transportFetch).connectWithSession(SESSION_JWE, 'device-stable');
    const second = await build(transportFetch).connectWithSession(SESSION_JWE, 'device-stable');

    expect(first.deviceId).toBe('device-stable');
    expect(second.deviceId).toBe('device-stable');
  });

  it('leaves the previous jar intact when a reconnect mint fails', async () => {
    const deviceId = 'device-keep-jar';
    const path = seedChatGPTWebSessionJar(deviceId, 'old-session');
    seedCookieJar(path, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);

    const transportFetch = vi.fn().mockResolvedValue(jsonResponse({ WARNING_BANNER: 'nope' }));

    await expect(
      build(transportFetch).connectWithSession(SESSION_JWE, deviceId),
    ).rejects.toThrowError(expect.objectContaining({ code: 'session_invalid' }));

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('_cfuvid\tcf-live');
  });

  it('does not scribble the live context jar while a reconnect mint is in flight or after it fails', async () => {
    const accountId = 'platform:chatgptweb';
    const deviceId = 'device-keep-live-context';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId,
    })!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedChatGPTWebSessionJar(live.cookieJarKey, 'old-session', undefined, deviceId);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);

    const assertLiveUntouched = () => {
      const contents = readFileSync(livePath, 'utf8');
      expect(contents).toContain('old-session');
      expect(contents).toContain('_cfuvid\tcf-live');
      expect(contents).not.toContain(SESSION_JWE);
    };

    const transportFetch = vi.fn().mockImplementation(async () => {
      assertLiveUntouched();
      return jsonResponse({ WARNING_BANNER: 'nope' });
    });

    await expect(
      new ChatGPTWebOAuthService({
        authFetch: vi.fn() as unknown as typeof fetch,
        browserProfile: PERSISTED_PROFILE,
        browserSessionAccountId: accountId,
        transportFetch: transportFetch as unknown as typeof fetch,
      }).connectWithSession(SESSION_JWE, deviceId),
    ).rejects.toThrowError(expect.objectContaining({ code: 'session_invalid' }));

    assertLiveUntouched();
    const sessionCall = transportFetch.mock.calls.find(([url]) =>
      String(url).endsWith('/api/auth/session'),
    );
    expect(sessionCall).toBeDefined();
    expect(
      (sessionCall![1] as { headers: Record<string, string> }).headers[COOKIE_JAR_HEADER],
    ).not.toBe(live.cookieJarKey);
  });

  it('leaves the live jar unchanged when persist is skipped after a successful mint', async () => {
    const accountId = 'platform:chatgptweb';
    const deviceId = 'device-persist-fail-session';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId,
    })!;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    seedChatGPTWebSessionJar(live.cookieJarKey, 'old-session', undefined, deviceId);
    seedCookieJar(livePath, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-live' }]);
    const liveId = live.contextId;

    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(
        sessionResponse(
          { accessToken: jwt({ exp: futureExp }) },
          { setCookie: [`${SESSION_COOKIE}=new-session; Path=/`] },
        ),
      )
      .mockResolvedValue(jsonResponse({}));

    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      browserSessionAccountId: accountId,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    await service.connectWithSession(SESSION_JWE, deviceId);

    expect(getBrowserSessionRegistry().get(liveId)?.lifecycle).toBe('active');
    expect(readFileSync(livePath, 'utf8')).toContain('old-session');
    expect(readFileSync(livePath, 'utf8')).not.toContain('new-session');
    expect(readFileSync(livePath, 'utf8')).not.toContain(SESSION_JWE);

    service.discardVerifiedChatGPTWebSession();
    expect(getBrowserSessionRegistry().get(liveId)?.lifecycle).toBe('active');
    expect(readFileSync(livePath, 'utf8')).toContain('old-session');
    expect(readFileSync(livePath, 'utf8')).not.toContain('new-session');
  });

  it('refresh seedChatGPTWebSessionJar no-ops when the live context was rotated mid-refresh', async () => {
    const accountId = 'platform:chatgptweb';
    const deviceId = 'device-refresh-rotate';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId,
    })!;
    seedChatGPTWebSessionJar(live.cookieJarKey, 'old-session', undefined, deviceId);
    const liveId = live.contextId;

    const transportFetch = vi.fn(async () => {
      rotateChatGPTWebBrowserSession({
        accountId,
        browserProfile: PERSISTED_PROFILE,
        deviceId,
      })?.release?.();
      return sessionResponse(
        { accessToken: jwt({ exp: futureExp }) },
        { setCookie: [`${SESSION_COOKIE}=rotated-mid-refresh`] },
      );
    });

    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      browserSessionAccountId: accountId,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    await service.refreshAccessToken(config, SESSION_JWE, {
      deviceId,
      renewalKind: 'web_session',
    });

    expect(getBrowserSessionRegistry().get(liveId)).toBeUndefined();
    const next = getBrowserSessionRegistry().getForIdentity({
      accountId,
      origin: 'https://chatgpt.com',
      provider: 'chatgptweb',
    });
    expect(next).toBeDefined();
    expect(readFileSync(next!.cookieJar.path, 'utf8')).not.toContain('rotated-mid-refresh');
  });

  it('rotate after commit drains transport for the pre-rotate pool key', async () => {
    const accountId = 'platform:chatgptweb';
    const deviceId = 'device-commit-rotate-drain';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId,
    })!;
    const liveId = live.contextId;
    const livePath = resolveCookieJarPath(live.cookieJarKey);
    const preRotatePool = getBrowserSessionRegistry().get(liveId)!.transportPoolKey;

    const transportFetch = vi.fn();
    transportFetch
      .mockResolvedValueOnce(sessionResponse({ accessToken: jwt({ exp: futureExp }) }))
      .mockResolvedValue(jsonResponse({}));

    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      browserSessionAccountId: accountId,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    await service.connectWithSession(SESSION_JWE, deviceId);
    service.commitVerifiedChatGPTWebSession(deviceId);
    await getBrowserSessionRegistry().awaitPendingCleanup();

    expect(getBrowserSessionRegistry().get(liveId)).toBeUndefined();
    expect(existsSync(livePath)).toBe(false);
    const next = getBrowserSessionRegistry().getForIdentity({
      accountId,
      origin: 'https://chatgpt.com',
      provider: 'chatgptweb',
    });
    expect(next).toBeDefined();
    expect(next!.transportPoolKey).not.toBe(preRotatePool);
  });

  it('aborts a changed-device replacement race and does not rotate the newer live context', async () => {
    const accountId = 'platform:chatgptweb';
    const live = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId: 'device-a',
    })!;
    const transportFetch = vi.fn().mockResolvedValue(jsonResponse({ email: 'a@example.com' }));
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      browserSessionAccountId: accountId,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    await service.verifyAccessToken(jwt({ exp: futureExp }), 'device-a-candidate');

    const winner = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId: 'device-b',
    })!;
    expect(winner.contextId).not.toBe(live.contextId);

    service.commitVerifiedChatGPTWebSession('device-a-candidate');
    const still = getBrowserSessionRegistry().get(winner.contextId);
    expect(still?.lifecycle).toBe('active');
    expect(still?.logicalPageId).toBe(winner.logicalPageId);
  });

  it('aborts commit when the captured live context disappeared', async () => {
    const accountId = 'platform:chatgptweb';
    bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId: 'device-live',
    })!;
    const transportFetch = vi.fn().mockResolvedValue(jsonResponse({ email: 'a@example.com' }));
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      browserSessionAccountId: accountId,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    await service.verifyAccessToken(jwt({ exp: futureExp }), 'device-live');
    invalidateChatGPTWebBrowserSession(accountId);

    service.commitVerifiedChatGPTWebSession('device-live');
    expect(
      getBrowserSessionRegistry().getForIdentity({
        accountId,
        origin: 'https://chatgpt.com',
        provider: 'chatgptweb',
      }),
    ).toBeUndefined();
  });

  it('aborts commit when live appears after staging with no live context', async () => {
    const accountId = 'platform:chatgptweb-absent';
    const transportFetch = vi.fn().mockResolvedValue(jsonResponse({ email: 'a@example.com' }));
    const service = new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      browserSessionAccountId: accountId,
      transportFetch: transportFetch as unknown as typeof fetch,
    });
    await service.verifyAccessToken(jwt({ exp: futureExp }), 'device-first');
    const created = bindChatGPTWebBrowserSession({
      accountId,
      browserProfile: PERSISTED_PROFILE,
      deviceId: 'device-second',
    })!;
    const createdId = created.contextId;
    service.commitVerifiedChatGPTWebSession('device-first');
    expect(getBrowserSessionRegistry().get(createdId)?.lifecycle).toBe('active');
    expect(getBrowserSessionRegistry().get(createdId)?.logicalPageId).toBe(created.logicalPageId);
  });
});

describe('resolveChatGPTWebConnectDeviceId', () => {
  it('prefers the pasted device id over the envelope and a stored id', () => {
    expect(
      resolveChatGPTWebConnectDeviceId({
        envelopeDeviceId: 'envelope',
        existingDeviceId: 'stored',
        pastedDeviceId: 'chrome',
        webSessionOnly: true,
      }),
    ).toBe('chrome');
  });

  it('reuses the stored id on a web-session-only reconnect without a pasted device', () => {
    expect(
      resolveChatGPTWebConnectDeviceId({
        envelopeDeviceId: 'envelope',
        existingDeviceId: 'stored',
        webSessionOnly: true,
      }),
    ).toBe('stored');
  });

  it('does not fall back to the envelope id for a web-session-only first connect', () => {
    expect(
      resolveChatGPTWebConnectDeviceId({
        envelopeDeviceId: 'envelope',
        webSessionOnly: true,
      }),
    ).toBeUndefined();
  });

  it('uses the envelope id when the provider is not web-session-only and nothing was pasted', () => {
    expect(
      resolveChatGPTWebConnectDeviceId({
        envelopeDeviceId: 'envelope',
        webSessionOnly: false,
      }),
    ).toBe('envelope');
  });
});

describe('web-capable token provenance', () => {
  const build = (transportFetch: ReturnType<typeof vi.fn>) =>
    new ChatGPTWebOAuthService({
      authFetch: vi.fn() as unknown as typeof fetch,
      browserProfile: PERSISTED_PROFILE,
      transportFetch: transportFetch as unknown as typeof fetch,
    });

  it('rejects a pasted Codex CLI token before spending a request on it', async () => {
    const transportFetch = vi.fn();
    const codexToken = jwt({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', exp: futureExp });

    await expect(build(transportFetch).verifyAccessToken(codexToken)).rejects.toThrowError(
      expect.objectContaining({ code: 'token_not_web' }),
    );
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['the real web client', 'app_X8zY6vW2pQ9tR3dE7nK1jL5gH'],
    ['our own PKCE client', 'app_2SKx67EdpoN0G6j64rFvigXD'],
    ['an unknown client id', 'app_SomethingNewOpenAIShipped'],
  ])('accepts a token from %s', async (_label, clientId) => {
    const transportFetch = vi.fn().mockResolvedValue(jsonResponse({ email: 'me@example.com' }));

    const connection = await build(transportFetch).verifyAccessToken(
      jwt({ client_id: clientId, exp: futureExp }),
    );

    expect(connection.email).toBe('me@example.com');
  });

  it('rejects a session that minted a token without web permission', async () => {
    const transportFetch = vi.fn().mockResolvedValue(
      sessionResponse({
        accessToken: jwt({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', exp: futureExp }),
      }),
    );

    await expect(build(transportFetch).connectWithSession(SESSION_JWE)).rejects.toThrowError(
      expect.objectContaining({ code: 'token_not_web' }),
    );
  });
});

import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import {
  ChatGPTWebOAuthError,
  ChatGPTWebOAuthService,
  type ChatGPTWebPasteEnvelope,
  parseCallbackInput,
  parsePasteEnvelope,
} from './oauthService';

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

const futureExp = Math.floor(Date.now() / 1000) + 86_400;

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
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'dnt': '1',
      'origin': 'https://platform.openai.com',
      'priority': 'u=1, i',
      'referer': 'https://platform.openai.com/',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-gpc': '1',
    });
    expect(headers['user-agent']).toContain('Chrome/136');
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

    const headers = transportFetch.mock.calls[0][1].headers;
    expect(headers.authorization).toBe(`Bearer ${jwt({ exp: futureExp })}`);
    expect(headers['oai-device-id']).toBe(connection.deviceId);
    expect(headers['oai-language']).toBe('en-US');
    expect(headers['user-agent']).toContain('Chrome/136');
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
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers['User-Agent']).toContain('Chrome/136');
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
});

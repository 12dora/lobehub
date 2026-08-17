// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthInvalidGrantError } from '../../index';
import {
  buildCursorDeviceAuthorization,
  CURSOR_API_ORIGIN,
  CURSOR_LOGIN_TTL_SECONDS,
  CURSOR_OAUTH_CLIENT_ID,
  CURSOR_USER_AGENT,
  CURSOR_WEBSITE_ORIGIN,
  cursorChallengeFromVerifier,
  CursorOAuthService,
  decodeCursorDeviceCode,
  encodeCursorDeviceCode,
} from '../../providers/cursor';
import { getOAuthService } from '../../providers/githubCopilot';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const config = {
  allowAccessTokenPaste: true,
  clientId: 'cursor-cli',
  defaultPollingInterval: 3,
  deviceCodeEndpoint: 'https://cursor.com/loginDeepControl',
  pastedCredentialKind: 'apiKey' as const,
  refreshTokenGrant: true,
  scopes: [],
  tokenEndpoint: `${CURSOR_API_ORIGIN}/auth/poll`,
  tokenExchangeEndpoint: `${CURSOR_API_ORIGIN}/auth/exchange_user_api_key`,
};

const FIXED_VERIFIER = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const FIXED_UUID = '11111111-2222-4333-8444-555555555555';

const jsonResponse = (body: unknown, status = 200) => ({
  json: () => Promise.resolve(body),
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
});

const buildJwt = (claims: object) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
    JSON.stringify(claims),
  ).toString('base64url')}.sig`;

describe('CursorOAuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is selected by the OAuth service factory before the grant-flow branch', () => {
    expect(getOAuthService('cursor')).toBeInstanceOf(CursorOAuthService);
  });

  it('derives the S256 challenge from the base64url verifier string', () => {
    const built = buildCursorDeviceAuthorization(FIXED_VERIFIER, FIXED_UUID, 3);
    const challenge = cursorChallengeFromVerifier(FIXED_VERIFIER);
    const decoded = decodeCursorDeviceCode(built.deviceCode);

    expect(FIXED_VERIFIER).toHaveLength(43);
    expect(decoded).toEqual({ uuid: FIXED_UUID, verifier: FIXED_VERIFIER });
    expect(built).toEqual({
      deviceCode: encodeCursorDeviceCode(FIXED_UUID, FIXED_VERIFIER),
      expiresIn: CURSOR_LOGIN_TTL_SECONDS,
      interval: 3,
      userCode: '',
      verificationUri: `${CURSOR_WEBSITE_ORIGIN}/loginDeepControl`,
      verificationUriComplete: `${CURSOR_WEBSITE_ORIGIN}/loginDeepControl?challenge=${challenge}&uuid=${FIXED_UUID}&mode=login&redirectTarget=cli`,
    });
  });

  it('initiates a URL-only device authorization with an empty user code', async () => {
    const result = await new CursorOAuthService().initiateDeviceCode(config);
    const { uuid, verifier } = decodeCursorDeviceCode(result.deviceCode);

    expect(result.userCode).toBe('');
    expect(result.expiresIn).toBe(CURSOR_LOGIN_TTL_SECONDS);
    expect(result.interval).toBe(3);
    expect(result.verificationUri).toBe(`${CURSOR_WEBSITE_ORIGIN}/loginDeepControl`);
    expect(result.verificationUriComplete).toBe(
      `${CURSOR_WEBSITE_ORIGIN}/loginDeepControl?challenge=${cursorChallengeFromVerifier(verifier)}&uuid=${uuid}&mode=login&redirectTarget=cli`,
    );
    expect(verifier).toHaveLength(43);
  });

  it('maps poll 404 to pending', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

    const result = await new CursorOAuthService().pollForToken(
      config,
      encodeCursorDeviceCode(FIXED_UUID, FIXED_VERIFIER),
    );

    expect(result).toEqual({ status: 'pending' });
    expect(mockFetch).toHaveBeenCalledWith(
      `${config.tokenEndpoint}?uuid=${FIXED_UUID}&verifier=${FIXED_VERIFIER}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'User-Agent': CURSOR_USER_AGENT,
        }),
        method: 'GET',
      }),
    );
  });

  it('maps poll 403 sign_in_policy_violation to denied', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'sign_in_policy_violation' }, 403));

    const result = await new CursorOAuthService().pollForToken(
      config,
      encodeCursorDeviceCode(FIXED_UUID, FIXED_VERIFIER),
    );

    expect(result).toEqual({ status: 'denied' });
  });

  it('keeps other non-OK poll responses pending so the shared poller can time out', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'upstream' }, 502));

    const result = await new CursorOAuthService().pollForToken(
      config,
      encodeCursorDeviceCode(FIXED_UUID, FIXED_VERIFIER),
    );

    expect(result).toEqual({ status: 'pending' });
  });

  it('maps a 200 poll with accessToken + refreshToken to success', async () => {
    const accessToken = buildJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValueOnce(jsonResponse({ accessToken, refreshToken: 'browser-refresh' }));

    const result = await new CursorOAuthService().pollForToken(
      config,
      encodeCursorDeviceCode(FIXED_UUID, FIXED_VERIFIER),
    );

    expect(result.status).toBe('success');
    expect(result.tokens).toEqual({
      accessToken,
      expiresIn: 3600,
      refreshToken: 'browser-refresh',
      renewalKind: 'oauth',
      tokenType: 'bearer',
    });
  });

  it('exchanges a pasted API key and stores it as the renewal credential', async () => {
    const accessToken = buildJwt({ exp: Math.floor(Date.now() / 1000) + 120 });
    mockFetch.mockResolvedValueOnce(jsonResponse({ accessToken, refreshToken: 'ignored-rt' }));

    const result = await new CursorOAuthService().exchangePastedCredential(config, 'key_live_abc');

    expect(result.status).toBe('success');
    expect(result.tokens).toEqual({
      accessToken,
      expiresIn: 120,
      refreshToken: 'key_live_abc',
      renewalKind: 'cursor_api_key',
      tokenType: 'bearer',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      config.tokenExchangeEndpoint,
      expect.objectContaining({
        body: '{}',
        headers: expect.objectContaining({
          'Authorization': 'Bearer key_live_abc',
          'Content-Type': 'application/json',
          'User-Agent': CURSOR_USER_AGENT,
        }),
        method: 'POST',
      }),
    );
  });

  it('re-exchanges a cursor_api_key refresh and returns the API key unchanged', async () => {
    const accessToken = buildJwt({ exp: Math.floor(Date.now() / 1000) + 60 });
    mockFetch.mockResolvedValueOnce(jsonResponse({ accessToken }));

    const tokens = await new CursorOAuthService().refreshAccessToken(config, 'key_live_abc', {
      renewalKind: 'cursor_api_key',
    });

    expect(tokens.refreshToken).toBe('key_live_abc');
    expect(tokens.renewalKind).toBe('cursor_api_key');
    expect(tokens.accessToken).toBe(accessToken);
  });

  it('treats a key_-prefixed refresh token as an API key even without the label', async () => {
    const accessToken = buildJwt({ exp: Math.floor(Date.now() / 1000) + 60 });
    mockFetch.mockResolvedValueOnce(jsonResponse({ accessToken }));

    const tokens = await new CursorOAuthService().refreshAccessToken(config, 'key_unlabelled');

    expect(tokens.renewalKind).toBe('cursor_api_key');
    expect(mockFetch).toHaveBeenCalledWith(
      config.tokenExchangeEndpoint,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses a working browser-login refresh grant when Cursor honours it', async () => {
    const accessToken = buildJwt({ exp: Math.floor(Date.now() / 1000) + 90 });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: accessToken, token_type: 'bearer' }),
    );

    const tokens = await new CursorOAuthService().refreshAccessToken(
      config,
      'browser-refresh-token',
      { renewalKind: 'oauth' },
    );

    expect(tokens).toEqual({
      accessToken,
      expiresIn: 90,
      refreshToken: 'browser-refresh-token',
      renewalKind: 'oauth',
      tokenType: 'bearer',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      `${CURSOR_API_ORIGIN}/oauth/token`,
      expect.objectContaining({
        body: JSON.stringify({
          client_id: CURSOR_OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: 'browser-refresh-token',
        }),
        method: 'POST',
      }),
    );
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('stamps invalid_grant when the JSON refresh grant is refused', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(
      new CursorOAuthService().refreshAccessToken(config, 'browser-refresh-token', {
        renewalKind: 'oauth',
      }),
    ).rejects.toBeInstanceOf(OAuthInvalidGrantError);
  });

  it('keeps a generic error on a transient refresh failure so keepalive does not mark reauth', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'unavailable' }, 503));

    await expect(
      new CursorOAuthService().refreshAccessToken(config, 'browser-refresh-token', {
        renewalKind: 'oauth',
      }),
    ).rejects.toThrow(/Failed to refresh Cursor browser-login token: 503/);
    await expect(
      new CursorOAuthService().refreshAccessToken(config, 'browser-refresh-token', {
        renewalKind: 'oauth',
      }),
    ).rejects.not.toBeInstanceOf(OAuthInvalidGrantError);
  });

  it('maps terminal API-key rejections to OAuthInvalidGrantError', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'invalid_api_key' }, 400));
    await expect(
      new CursorOAuthService().refreshAccessToken(config, 'key_live_abc', {
        renewalKind: 'cursor_api_key',
      }),
    ).rejects.toBeInstanceOf(OAuthInvalidGrantError);

    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));
    await expect(
      new CursorOAuthService().refreshAccessToken(config, 'key_live_abc', {
        renewalKind: 'cursor_api_key',
      }),
    ).rejects.toBeInstanceOf(OAuthInvalidGrantError);

    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'sign_in_policy_violation' }, 403));
    await expect(
      new CursorOAuthService().refreshAccessToken(config, 'key_live_abc', {
        renewalKind: 'cursor_api_key',
      }),
    ).rejects.toBeInstanceOf(OAuthInvalidGrantError);
  });

  it('keeps 429/5xx API-key exchange failures generic so they stay transient', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429));
    await expect(
      new CursorOAuthService().refreshAccessToken(config, 'key_live_abc', {
        renewalKind: 'cursor_api_key',
      }),
    ).rejects.toThrow(/Failed to exchange Cursor API key: 429/);
    await expect(
      (async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));
        await new CursorOAuthService().refreshAccessToken(config, 'key_live_abc', {
          renewalKind: 'cursor_api_key',
        });
      })(),
    ).rejects.not.toBeInstanceOf(OAuthInvalidGrantError);
  });
});

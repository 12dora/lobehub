// @vitest-environment node
import {
  DEFAULT_BROWSER_DEVICE_PROFILE,
  generateBrowserDeviceProfile,
} from '@lobechat/model-runtime/browserProfile';
import { AgentRuntimeErrorType } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureFreshOAuthToken } from '../refresh';

const { mockGetAiProviderById, mockUpdateConfig } = vi.hoisted(() => ({
  mockGetAiProviderById: vi.fn(),
  mockUpdateConfig: vi.fn(),
}));

vi.mock('@/database/models/aiProvider', () => ({
  // class-based mock so it survives vi.clearAllMocks/resetAllMocks
  AiProviderModel: class {
    getAiProviderById = mockGetAiProviderById;
    updateConfig = mockUpdateConfig;
  },
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    getUserKeyVaults: vi.fn(),
    initWithEnvKey: () => Promise.resolve({ encrypt: (s: string) => s }),
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

/**
 * ChatGPT Web's web-session renewal goes through the impersonate transport (chatgpt.com
 * answers Node's own fetch with a bot challenge), which spawns a real child process — so
 * the transport itself is the seam.
 */
const { mockTransportFetch } = vi.hoisted(() => ({ mockTransportFetch: vi.fn() }));

vi.mock('@/server/enterprise/services/chatgptWeb/transport', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getChatGPTWebFetch: () => mockTransportFetch,
}));

/** Build an unsigned JWT with the given exp claim (seconds) */
const buildJwt = (expSeconds: number) => {
  const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.sig`;
};

const config = {
  clientId: 'test-client-id',
  deviceCodeEndpoint: 'https://auth.example.com/device/code',
  refreshTokenGrant: true,
  scopes: ['offline_access'],
  tokenEndpoint: 'https://auth.example.com/token',
};

const db = {} as any;

let userSeq = 0;
/** Fresh identity per test to avoid single-flight key collisions */
const makeParams = (keyVaults: any) => ({
  config,
  db,
  keyVaults,
  providerId: 'supergrok',
  userId: `user-${++userSeq}`,
});

const tokenResponse = (body: object, ok = true) => ({
  json: () => Promise.resolve(body),
  ok,
  status: ok ? 200 : 400,
});

describe('ensureFreshOAuthToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns keyVaults untouched when not connected via OAuth', async () => {
    const keyVaults = { apiKey: 'sk-xxx' };
    const result = await ensureFreshOAuthToken(makeParams(keyVaults));

    expect(result).toBe(keyVaults);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns keyVaults untouched when there is no refresh token', async () => {
    const keyVaults = { oauthAccessToken: 'access-token' };
    const result = await ensureFreshOAuthToken(makeParams(keyVaults));

    expect(result).toBe(keyVaults);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips refresh when the token is still fresh', async () => {
    const keyVaults = {
      oauthAccessToken: 'access-token',
      oauthLastRefreshAt: String(Date.now()),
      oauthRefreshToken: 'refresh-token',
      oauthTokenExpiresAt: String(Date.now() + 30 * 60 * 1000),
    };

    const result = await ensureFreshOAuthToken(makeParams(keyVaults));

    expect(result).toBe(keyVaults);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes when the stored expiry is within the skew window', async () => {
    mockFetch.mockResolvedValueOnce(
      tokenResponse({
        access_token: 'new-access',
        expires_in: 3600,
        refresh_token: 'new-refresh',
        token_type: 'bearer',
      }),
    );

    const result = await ensureFreshOAuthToken(
      makeParams({
        oauthAccessToken: 'old-access',
        oauthRefreshToken: 'old-refresh',
        oauthTokenExpiresAt: String(Date.now() + 30 * 1000),
      }),
    );

    expect(result.oauthAccessToken).toBe('new-access');
    expect(result.oauthRefreshToken).toBe('new-refresh');
    expect(Number(result.oauthTokenExpiresAt)).toBeGreaterThan(Date.now() + 3000 * 1000);

    // refresh_token grant request shape
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(config.tokenEndpoint);
    expect(init.body).toContain('grant_type=refresh_token');
    expect(init.body).toContain('refresh_token=old-refresh');

    // rotated pair persisted before returning
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      'supergrok',
      expect.objectContaining({
        keyVaults: expect.objectContaining({
          oauthAccessToken: 'new-access',
          oauthRefreshToken: 'new-refresh',
        }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('persists x.ai userinfo identity on refresh when the JWT has no email', async () => {
    const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const accessJwt = `${encode({ alg: 'none' })}.${encode({
      iss: 'https://auth.x.ai',
      sub: '81f4abc',
    })}.sig`;
    mockUpdateConfig.mockResolvedValue(undefined);
    mockFetch
      .mockResolvedValueOnce(
        tokenResponse({
          access_token: accessJwt,
          expires_in: 3600,
          refresh_token: 'new-refresh',
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            email: 'user@example.com',
            email_verified: true,
            family_name: '',
            given_name: 'Ada',
            name: 'Ada Lovelace',
            picture: 'https://auth.x.ai/picture',
            sub: '81f4abc',
          }),
        ok: true,
        status: 200,
      });

    const result = await ensureFreshOAuthToken({
      config: { ...config, tokenEndpoint: 'https://auth.x.ai/oauth2/token' },
      db,
      keyVaults: {
        oauthAccessToken: 'old-access',
        oauthRefreshToken: 'old-refresh',
        oauthTokenExpiresAt: String(Date.now() + 30 * 1000),
      },
      providerId: 'supergrok',
      userId: `user-${++userSeq}`,
    });

    expect(result.oauthAccountEmail).toBe('user@example.com');
    expect(result.oauthAccountId).toBe('81f4abc');
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      'supergrok',
      expect.objectContaining({
        keyVaults: expect.objectContaining({
          oauthAccessToken: accessJwt,
          oauthAccountEmail: 'user@example.com',
          oauthAccountId: '81f4abc',
          oauthRefreshToken: 'new-refresh',
        }),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://auth.x.ai/oauth2/userinfo',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('refreshes when only the JWT exp claim says the token is expiring', async () => {
    mockFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    );

    const result = await ensureFreshOAuthToken(
      makeParams({
        // no stored expiry — JWT exp in the past is the only signal
        oauthAccessToken: buildJwt(Math.floor(Date.now() / 1000) - 10),
        oauthRefreshToken: 'old-refresh',
      }),
    );

    expect(result.oauthAccessToken).toBe('new-access');
  });

  it('derives expiry from the new JWT when expires_in is missing', async () => {
    const exp = Math.floor(Date.now() / 1000) + 1800;
    mockFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: buildJwt(exp), refresh_token: 'new-refresh' }),
    );

    const result = await ensureFreshOAuthToken(
      makeParams({
        oauthAccessToken: 'old-access',
        oauthRefreshToken: 'old-refresh',
        oauthTokenExpiresAt: String(Date.now() - 1000),
      }),
    );

    expect(Number(result.oauthTokenExpiresAt)).toBe(exp * 1000);
  });

  it('keeps the old refresh token when the provider does not rotate', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse({ access_token: 'new-access' }));

    const result = await ensureFreshOAuthToken(
      makeParams({
        oauthAccessToken: 'old-access',
        oauthRefreshToken: 'old-refresh',
        oauthTokenExpiresAt: String(Date.now() - 1000),
      }),
    );

    expect(result.oauthRefreshToken).toBe('old-refresh');
  });

  it('collapses concurrent refreshes onto a single HTTP call', async () => {
    mockFetch.mockResolvedValue(
      tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    );

    const params = makeParams({
      oauthAccessToken: 'old-access',
      oauthRefreshToken: 'old-refresh',
      oauthTokenExpiresAt: String(Date.now() - 1000),
    });

    const [a, b, c] = await Promise.all([
      ensureFreshOAuthToken(params),
      ensureFreshOAuthToken(params),
      ensureFreshOAuthToken(params),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(a.oauthAccessToken).toBe('new-access');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('rejects with InvalidProviderAPIKey when persisting the rotated pair fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    );
    // Exhaust transient retries — never return a token pair that only exists in memory.
    mockUpdateConfig
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'));
    mockGetAiProviderById.mockResolvedValueOnce({
      keyVaults: {
        oauthAccessToken: 'old-access',
        oauthRefreshToken: 'old-refresh',
        oauthTokenExpiresAt: String(Date.now() - 1000),
      },
    });

    await expect(
      ensureFreshOAuthToken(
        makeParams({
          oauthAccessToken: 'old-access',
          oauthRefreshToken: 'old-refresh',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        }),
      ),
    ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.InvalidProviderAPIKey });

    expect(mockUpdateConfig).toHaveBeenCalledTimes(3);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('serves the durable rotated pair on a following request after a successful persist', async () => {
    mockUpdateConfig.mockResolvedValue(undefined);
    mockFetch.mockResolvedValueOnce(
      tokenResponse({
        access_token: 'new-access',
        expires_in: 3600,
        refresh_token: 'new-refresh',
      }),
    );

    const params = makeParams({
      oauthAccessToken: 'old-access',
      oauthRefreshToken: 'old-refresh',
      oauthTokenExpiresAt: String(Date.now() - 1000),
    });

    const first = await ensureFreshOAuthToken(params);
    expect(first.oauthAccessToken).toBe('new-access');
    expect(first.oauthRefreshToken).toBe('new-refresh');
    expect(mockUpdateConfig).toHaveBeenCalledOnce();

    // Second request observes the stored rotated pair and does not re-hit the provider.
    mockFetch.mockClear();
    mockUpdateConfig.mockClear();

    const second = await ensureFreshOAuthToken({
      ...params,
      keyVaults: {
        oauthAccessToken: first.oauthAccessToken,
        // The real caller re-reads the row, which now carries the keepalive anchor too.
        oauthLastRefreshAt: first.oauthLastRefreshAt,
        oauthRefreshToken: first.oauthRefreshToken,
        oauthTokenExpiresAt: first.oauthTokenExpiresAt,
      },
    });

    expect(second.oauthAccessToken).toBe('new-access');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('recovers from a transient persist failure when a concurrent writer stored the pair', async () => {
    mockFetch.mockResolvedValueOnce(
      tokenResponse({
        access_token: 'new-access',
        expires_in: 3600,
        refresh_token: 'new-refresh',
      }),
    );
    mockUpdateConfig
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'));
    mockGetAiProviderById.mockResolvedValueOnce({
      keyVaults: {
        oauthAccessToken: 'new-access',
        oauthRefreshToken: 'new-refresh',
        oauthTokenExpiresAt: String(Date.now() + 30 * 60 * 1000),
      },
    });

    const result = await ensureFreshOAuthToken(
      makeParams({
        oauthAccessToken: 'old-access',
        oauthRefreshToken: 'old-refresh',
        oauthTokenExpiresAt: String(Date.now() - 1000),
      }),
    );

    expect(result.oauthAccessToken).toBe('new-access');
    expect(result.oauthRefreshToken).toBe('new-refresh');
  });

  describe('invalid_grant self-healing', () => {
    it('uses stored credentials when another instance already rotated to a fresh pair', async () => {
      mockFetch.mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, false));
      mockGetAiProviderById.mockResolvedValueOnce({
        keyVaults: {
          oauthAccessToken: 'rotated-access',
          oauthRefreshToken: 'rotated-refresh',
          oauthTokenExpiresAt: String(Date.now() + 30 * 60 * 1000),
        },
      });

      const result = await ensureFreshOAuthToken(
        makeParams({
          oauthAccessToken: 'old-access',
          oauthRefreshToken: 'old-refresh',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        }),
      );

      expect(result.oauthAccessToken).toBe('rotated-access');
      // no second refresh call needed
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('retries once with the stored refresh token when the rotated access token is also stale', async () => {
      mockFetch
        .mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, false))
        .mockResolvedValueOnce(
          tokenResponse({
            access_token: 'second-access',
            expires_in: 3600,
            refresh_token: 'second-refresh',
          }),
        );
      mockGetAiProviderById.mockResolvedValueOnce({
        keyVaults: {
          oauthAccessToken: 'rotated-but-stale-access',
          oauthRefreshToken: 'rotated-refresh',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        },
      });

      const result = await ensureFreshOAuthToken(
        makeParams({
          oauthAccessToken: 'old-access',
          oauthRefreshToken: 'old-refresh',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        }),
      );

      expect(result.oauthAccessToken).toBe('second-access');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [, retryInit] = mockFetch.mock.calls[1];
      expect(retryInit.body).toContain('refresh_token=rotated-refresh');
    });

    it('throws OAuthAuthorizationExpired when the stored refresh token matches the rejected one', async () => {
      mockFetch.mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, false));
      mockGetAiProviderById.mockResolvedValueOnce({
        keyVaults: {
          oauthAccessToken: 'old-access',
          oauthRefreshToken: 'old-refresh',
        },
      });

      await expect(
        ensureFreshOAuthToken(
          makeParams({
            oauthAccessToken: 'old-access',
            oauthRefreshToken: 'old-refresh',
            oauthTokenExpiresAt: String(Date.now() - 1000),
          }),
        ),
      ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired });

      // keyVaults must NOT be cleared on failure
      expect(mockUpdateConfig).not.toHaveBeenCalled();
    });

    it('throws OAuthAuthorizationExpired when the retry also gets invalid_grant', async () => {
      mockFetch
        .mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, false))
        .mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, false));
      mockGetAiProviderById.mockResolvedValueOnce({
        keyVaults: {
          oauthAccessToken: 'rotated-but-stale-access',
          oauthRefreshToken: 'rotated-refresh',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        },
      });

      await expect(
        ensureFreshOAuthToken(
          makeParams({
            oauthAccessToken: 'old-access',
            oauthRefreshToken: 'old-refresh',
            oauthTokenExpiresAt: String(Date.now() - 1000),
          }),
        ),
      ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired });
    });
  });
});

/**
 * The refresh POLICY is the only production path that ever refreshes, so a provider whose
 * token endpoint needs a different wire has to be reachable THROUGH it. Instantiating the
 * base service here made `ChatGPTWebOAuthService.refreshAccessToken` dead code: refreshes
 * went out without the platform User-Agent, unbounded, and with provider prose in the
 * thrown message.
 */
describe('ensureFreshOAuthToken (chatgptweb override)', () => {
  const chatgptWebConfig = {
    clientId: 'app_2SKx67EdpoN0G6j64rFvigXD',
    deviceCodeEndpoint: 'https://auth.openai.com/api/accounts/authorize',
    grantFlow: 'authorization_code_paste' as const,
    refreshTokenGrant: true,
    scopes: ['openid', 'offline_access'],
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
  };

  const expiringVault = () => ({
    oauthAccessToken: 'at-old',
    oauthRefreshToken: 'rt-old',
    oauthTokenExpiresAt: String(Date.now() - 1000),
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('refreshes through the provider override: form body, User-Agent, bounded, rotated', async () => {
    mockUpdateConfig.mockResolvedValue(undefined);
    mockFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
    );

    const result = await ensureFreshOAuthToken({
      config: chatgptWebConfig as any,
      db,
      keyVaults: expiringVault(),
      providerId: 'chatgptweb',
      userId: `user-${++userSeq}`,
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(chatgptWebConfig.tokenEndpoint);
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    // The base service sends no UA at all — its presence IS the proof of the override.
    expect(init.headers['user-agent']).toContain('Chrome/150');
    expect(init.body).toContain('grant_type=refresh_token');
    expect(init.body).toContain('refresh_token=rt-old');
    // Bounded below the shared refresh lease.
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(result.oauthAccessToken).toBe('at-new');
    expect(result.oauthRefreshToken).toBe('rt-new');
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      'chatgptweb',
      expect.objectContaining({
        keyVaults: expect.objectContaining({
          oauthAccessToken: 'at-new',
          oauthRefreshToken: 'rt-new',
        }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  /**
   * The refresh path is one of the async seams that must hand the PERSISTED installation
   * identity down: refreshing behind a different User-Agent than the one that minted the
   * session is exactly the mismatch the shared profile exists to prevent.
   */
  it('presents the persisted browser profile, not the bundled fallback', async () => {
    mockUpdateConfig.mockResolvedValue(undefined);
    mockFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
    );
    const browserProfile = generateBrowserDeviceProfile({ seed: 'refresh-seam-installation' });
    expect(browserProfile.userAgent).not.toBe(DEFAULT_BROWSER_DEVICE_PROFILE.userAgent);

    await ensureFreshOAuthToken({
      browserProfile,
      config: chatgptWebConfig as any,
      db,
      keyVaults: expiringVault(),
      providerId: 'chatgptweb',
      userId: `user-${++userSeq}`,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['user-agent']).toBe(browserProfile.userAgent);
    expect(init.headers['sec-ch-ua']).toBe(browserProfile.secChUa);
    expect(init.headers['accept-language']).toBe(browserProfile.acceptLanguage);
  });

  it('never echoes the provider error_description into the surfaced error', async () => {
    mockFetch.mockResolvedValueOnce(
      tokenResponse(
        {
          error: 'server_error',
          error_description: 'REQUEST-ECHO refresh_token=rt-old was rejected',
        },
        false,
      ),
    );

    await expect(
      ensureFreshOAuthToken({
        config: chatgptWebConfig as any,
        db,
        keyVaults: expiringVault(),
        providerId: 'chatgptweb',
        userId: `user-${++userSeq}`,
      }),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining('REQUEST-ECHO'),
    });
  });

  it('maps invalid_grant to the reconnect-required terminal error', async () => {
    mockFetch.mockResolvedValue(
      tokenResponse({ error: 'invalid_grant', error_description: 'consumed' }, false),
    );
    mockGetAiProviderById.mockResolvedValue({ keyVaults: expiringVault() });

    await expect(
      ensureFreshOAuthToken({
        config: chatgptWebConfig as any,
        db,
        keyVaults: expiringVault(),
        providerId: 'chatgptweb',
        userId: `user-${++userSeq}`,
      }),
    ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired });
  });

  /**
   * A hung token endpoint used to run unbounded — and the platform path holds a 30 s
   * cross-instance lease across this very call. Once that lease expires, a second instance
   * refreshes with the SAME rotating token; providers answer that reuse by revoking the
   * whole grant family. The bound has to fire first, so it is 20 s.
   */
  it('aborts a hung token call within the bound instead of pinning the refresh lease', async () => {
    // Real timers cannot be waited out in a unit test; the deadline is driven directly, and
    // the timeout VALUE is asserted separately below.
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);

    mockFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // A token endpoint that accepts the connection and then says nothing — undici
          // rejects with an AbortError when the request signal fires.
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
          setTimeout(() => deadline.abort(), 0);
        }),
    );

    try {
      await expect(
        ensureFreshOAuthToken({
          config: chatgptWebConfig as any,
          db,
          keyVaults: expiringVault(),
          providerId: 'chatgptweb',
          userId: `user-${++userSeq}`,
        }),
        // Composed here from the error CLASS only — no provider prose, no transport detail.
      ).rejects.toThrow('Failed to refresh access token: AbortError');

      // Below the shared refresh lease (`LEASE_SECONDS = 30`), with room for the persist.
      for (const call of timeoutSpy.mock.calls) expect(call[0]).toBeLessThanOrEqual(20_000);
      expect(timeoutSpy).toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  /**
   * Web-session renewal: the pipeline is untouched — the same skew/keepalive/backoff policy,
   * the same single-flight and persist-then-use ordering. Only HOW the leaf is spent
   * differs. The renewal kind travels from the vault to the provider through
   * `OAuthRefreshOptions`, which is the one seam that had to exist for this.
   */
  describe('web-session renewal credential', () => {
    /** next-auth compact JWE: `dir` header, empty encrypted-key segment. */
    const sessionJwe = [
      Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url'),
      '',
      'aXY',
      'Y3Q',
      'dGFn',
    ].join('.');

    const sessionResponse = (accessToken: string, rotated?: string) => {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (rotated) headers.append('set-cookie', `__Secure-next-auth.session-token=${rotated}`);
      return new Response(JSON.stringify({ accessToken }), { headers, status: 200 });
    };

    it('spends the leaf at chatgpt.com when the vault labels it a web session', async () => {
      mockUpdateConfig.mockResolvedValue(undefined);
      mockTransportFetch.mockResolvedValueOnce(sessionResponse('at-new', 'session-rotated'));

      const result = await ensureFreshOAuthToken({
        config: chatgptWebConfig as any,
        db,
        keyVaults: {
          oauthAccessToken: 'at-old',
          oauthRefreshToken: sessionJwe,
          oauthRenewalKind: 'web_session',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        },
        providerId: 'chatgptweb',
        userId: `user-${++userSeq}`,
      });

      // The OAuth token endpoint is never called on this path.
      expect(mockFetch).not.toHaveBeenCalled();
      expect(String(mockTransportFetch.mock.calls[0][0])).toBe(
        'https://chatgpt.com/api/auth/session',
      );
      expect(result.oauthAccessToken).toBe('at-new');
      // The rotated cookie is what gets stored — the consumed one would 401 next time.
      expect(result.oauthRefreshToken).toBe('session-rotated');
      // The kind is carried forward: a rotation replaces the credential, not its kind.
      expect(result.oauthRenewalKind).toBe('web_session');
      expect(mockUpdateConfig).toHaveBeenCalledWith(
        'chatgptweb',
        expect.objectContaining({
          keyVaults: expect.objectContaining({
            oauthAccessToken: 'at-new',
            oauthRefreshToken: 'session-rotated',
          }),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('identifies a session credential by shape when the vault predates the label', async () => {
      mockUpdateConfig.mockResolvedValue(undefined);
      mockTransportFetch.mockResolvedValueOnce(sessionResponse('at-new'));

      const result = await ensureFreshOAuthToken({
        config: chatgptWebConfig as any,
        db,
        keyVaults: {
          oauthAccessToken: 'at-old',
          oauthRefreshToken: sessionJwe,
          oauthTokenExpiresAt: String(Date.now() - 1000),
        },
        providerId: 'chatgptweb',
        userId: `user-${++userSeq}`,
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.oauthAccessToken).toBe('at-new');
      // Nothing rotated: the presented session stays the renewal credential.
      expect(result.oauthRefreshToken).toBe(sessionJwe);
    });

    /**
     * Connect presents `oai-did`; a renewal that omitted it looked like a brand-new device
     * every time, to the one host whose bot filter is why this path exists. The id travels
     * from the vault leaf through `OAuthRefreshOptions`, exactly like the renewal kind.
     */
    it('presents the stored device id on the session renewal', async () => {
      mockUpdateConfig.mockResolvedValue(undefined);
      mockTransportFetch.mockResolvedValueOnce(sessionResponse('at-new'));

      await ensureFreshOAuthToken({
        config: chatgptWebConfig as any,
        db,
        keyVaults: {
          oauthAccessToken: 'at-old',
          oauthDeviceId: 'a3f7c0f7-6f6e-4a1b-9c2d-8e5a1b2c3d4e',
          oauthRefreshToken: sessionJwe,
          oauthRenewalKind: 'web_session',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        },
        providerId: 'chatgptweb',
        userId: `user-${++userSeq}`,
      });

      expect(mockTransportFetch.mock.calls[0][1].headers.cookie).toBe(
        `oai-did=a3f7c0f7-6f6e-4a1b-9c2d-8e5a1b2c3d4e; __Secure-next-auth.session-token=${sessionJwe}`,
      );
    });

    /**
     * The leaf is durable state an older writer (or an admin credential edit) can put anything
     * in. An unrecognised label must be treated as ABSENT so the shape fallback still runs —
     * passing it through would take the default branch and present a session cookie as an
     * OAuth refresh token.
     */
    it('treats an unrecognised stored kind as absent and identifies the credential by shape', async () => {
      mockUpdateConfig.mockResolvedValue(undefined);
      mockTransportFetch.mockResolvedValueOnce(sessionResponse('at-new'));

      const result = await ensureFreshOAuthToken({
        config: chatgptWebConfig as any,
        db,
        keyVaults: {
          oauthAccessToken: 'at-old',
          oauthRefreshToken: sessionJwe,
          oauthRenewalKind: 'browser_cookie',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        },
        providerId: 'chatgptweb',
        userId: `user-${++userSeq}`,
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.oauthAccessToken).toBe('at-new');
    });

    /**
     * The self-heal spends a DIFFERENT credential than the one that failed, and a concurrent
     * reconnect may have switched what that credential IS. Reusing the original kind would
     * present a freshly stored OAuth refresh token at chatgpt.com as a session cookie (or the
     * reverse) — a terminal failure on a connection that was just made.
     */
    it('spends the replacement credential the way ITS OWN vault says, after a kind switch', async () => {
      mockUpdateConfig.mockResolvedValue(undefined);
      // The stored session is dead: a parsed 200 that mints nothing is invalid_grant here.
      mockTransportFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
      // Meanwhile an operator reconnected through the authorization page: same leaf, other kind.
      mockGetAiProviderById.mockResolvedValueOnce({
        keyVaults: {
          oauthAccessToken: 'at-reconnected-but-stale',
          oauthRefreshToken: 'rt-from-pkce',
          oauthRenewalKind: 'oauth',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        },
      });
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );

      const result = await ensureFreshOAuthToken({
        config: chatgptWebConfig as any,
        db,
        keyVaults: {
          oauthAccessToken: 'at-old',
          oauthRefreshToken: sessionJwe,
          oauthRenewalKind: 'web_session',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        },
        providerId: 'chatgptweb',
        userId: `user-${++userSeq}`,
      });

      // The retry went to the TOKEN ENDPOINT with the replacement credential — not back to
      // chatgpt.com, which is what the original kind would have done.
      expect(mockTransportFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][1].body).toContain('refresh_token=rt-from-pkce');
      expect(result.oauthAccessToken).toBe('at-new');
      expect(result.oauthRefreshToken).toBe('rt-new');
      // And the kind that comes back is the one actually consumed, not the one we started on.
      expect(result.oauthRenewalKind).toBe('oauth');
    });

    it('still uses the token endpoint for an ordinary OAuth refresh token', async () => {
      mockUpdateConfig.mockResolvedValue(undefined);
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );

      await ensureFreshOAuthToken({
        config: chatgptWebConfig as any,
        db,
        keyVaults: { ...expiringVault(), oauthRenewalKind: 'oauth' },
        providerId: 'chatgptweb',
        userId: `user-${++userSeq}`,
      });

      expect(mockTransportFetch).not.toHaveBeenCalled();
      expect(mockFetch.mock.calls[0][0]).toBe(chatgptWebConfig.tokenEndpoint);
    });
  });
});

describe('ensureFreshOAuthToken (cursor api-key refresh)', () => {
  const cursorConfig = {
    clientId: 'cursor-cli',
    deviceCodeEndpoint: 'https://cursor.com/loginDeepControl',
    refreshTokenGrant: true,
    scopes: [],
    tokenEndpoint: 'https://api2.cursor.sh/auth/poll',
    tokenExchangeEndpoint: 'https://api2.cursor.sh/auth/exchange_user_api_key',
  };

  const expiringApiKeyVault = () => ({
    oauthAccessToken: 'at-old',
    oauthRefreshToken: 'key_live_abc',
    oauthRenewalKind: 'cursor_api_key',
    oauthTokenExpiresAt: String(Date.now() - 1000),
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('maps a rejected cursor_api_key exchange onto the reconnect-required reauth marker', async () => {
    const vault = expiringApiKeyVault();
    mockFetch.mockResolvedValue(tokenResponse({ error: 'invalid_api_key' }, false));
    mockGetAiProviderById.mockResolvedValue({ keyVaults: vault });

    await expect(
      ensureFreshOAuthToken({
        config: cursorConfig as any,
        db,
        keyVaults: vault,
        providerId: 'cursor',
        userId: `user-${++userSeq}`,
      }),
    ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired });
  });
});

/**
 * E2 §1.5 refresh lifecycle: a rarely-used rotating-refresh connection must not lose its
 * refresh token. Three knobs, each independently observable through the public entry
 * point (the individual predicates are module-private — every path, the keepalive sweep
 * included, decides through `shouldRefreshOAuthToken` — and the behaviour that matters is
 * "does a refresh actually go out").
 */
describe('refresh lifecycle policy', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** ChatGPT Web widens the proactive window to 24 h via `settings.oauthDeviceFlow`. */
  const wideSkewConfig = { ...config, refreshSkewMs: DAY_MS };

  const buildJwtWith = (claims: object) => {
    const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockUpdateConfig.mockResolvedValue(undefined);
  });

  describe('provider-configurable skew', () => {
    const nearlyADayLeft = () => ({
      oauthAccessToken: 'at-old',
      oauthLastRefreshAt: String(Date.now()),
      oauthRefreshToken: 'rt-old',
      oauthTokenExpiresAt: String(Date.now() + 23 * 60 * 60 * 1000),
    });

    it('leaves a token 23 h from expiry alone under the 2-minute default', async () => {
      const keyVaults = nearlyADayLeft();
      const result = await ensureFreshOAuthToken(makeParams(keyVaults));

      expect(result).toBe(keyVaults);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refreshes the same token when the provider declares a 24 h skew', async () => {
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );

      const result = await ensureFreshOAuthToken({
        ...makeParams(nearlyADayLeft()),
        config: wideSkewConfig,
      });

      expect(result.oauthAccessToken).toBe('at-new');
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe('3-day keepalive', () => {
    const stillValid = (lastRefreshAt: number) => ({
      oauthAccessToken: 'at-old',
      oauthLastRefreshAt: String(lastRefreshAt),
      oauthRefreshToken: 'rt-old',
      oauthTokenExpiresAt: String(Date.now() + 30 * 60 * 1000),
    });

    it('renews a still-valid token whose last refresh is older than 3 days', async () => {
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );

      const result = await ensureFreshOAuthToken(
        makeParams(stillValid(Date.now() - 3 * DAY_MS - 1000)),
      );

      expect(result.oauthAccessToken).toBe('at-new');
      // The anchor moves forward, so the next 3 days are quiet again.
      expect(Number(result.oauthLastRefreshAt)).toBeGreaterThan(Date.now() - 5000);
    });

    it('leaves a token refreshed 2 days ago alone', async () => {
      const keyVaults = stillValid(Date.now() - 2 * DAY_MS);
      const result = await ensureFreshOAuthToken(makeParams(keyVaults));

      expect(result).toBe(keyVaults);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('falls back to the JWT iat claim when no refresh has been recorded', async () => {
      const keyVaults = {
        oauthAccessToken: buildJwtWith({
          exp: Math.floor((Date.now() + 30 * 60 * 1000) / 1000),
          iat: Math.floor((Date.now() - DAY_MS) / 1000),
        }),
        oauthRefreshToken: 'rt-old',
      };

      const result = await ensureFreshOAuthToken(makeParams(keyVaults));

      expect(result).toBe(keyVaults);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('renews once when neither anchor exists, so the credential stops being unbounded', async () => {
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );

      const result = await ensureFreshOAuthToken(
        makeParams({
          oauthAccessToken: 'at-old',
          oauthRefreshToken: 'rt-old',
          oauthTokenExpiresAt: String(Date.now() + 30 * 60 * 1000),
        }),
      );

      expect(result.oauthAccessToken).toBe('at-new');
      expect(result.oauthLastRefreshAt).toBeDefined();
    });

    it('does not keepalive a provider without a rotating refresh grant', async () => {
      const keyVaults = {
        oauthAccessToken: 'at-old',
        oauthRefreshToken: 'rt-old',
        oauthTokenExpiresAt: String(Date.now() + 30 * 60 * 1000),
      };

      const result = await ensureFreshOAuthToken({
        ...makeParams(keyVaults),
        config: { ...config, refreshTokenGrant: false },
      });

      expect(result).toBe(keyVaults);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('5-minute failure backoff', () => {
    it('records the failure stamp as the ONLY leaf it writes', async () => {
      mockFetch.mockResolvedValueOnce(tokenResponse({ error: 'server_error' }, false));
      // Durable state still holds the credential that failed.
      mockGetAiProviderById.mockResolvedValue({
        keyVaults: {
          oauthAccessToken: 'at-old',
          oauthRefreshToken: 'rt-old',
          oauthTokenExpiresAt: String(Date.now() + 12 * 60 * 60 * 1000),
        },
      });

      await expect(
        ensureFreshOAuthToken({
          ...makeParams({
            oauthAccessToken: 'at-old',
            oauthLastRefreshAt: String(Date.now()),
            oauthRefreshToken: 'rt-old',
            oauthTokenExpiresAt: String(Date.now() + 12 * 60 * 60 * 1000),
          }),
          config: wideSkewConfig,
        }),
      ).rejects.toThrow();

      // A partial update: `updateConfig` merges over the stored row, so the token pair is
      // preserved by NOT being written — never by writing the captured copy back.
      expect(mockUpdateConfig).toHaveBeenCalledWith(
        'supergrok',
        { keyVaults: { oauthLastRefreshErrorAt: expect.any(String) } },
        expect.anything(),
        expect.anything(),
      );
    });

    it('skips the token endpoint for 5 minutes after a failure while the token still works', async () => {
      const keyVaults = {
        oauthAccessToken: 'at-old',
        oauthLastRefreshAt: String(Date.now()),
        oauthLastRefreshErrorAt: String(Date.now() - 60 * 1000),
        oauthRefreshToken: 'rt-old',
        // Inside the 24 h window, but comfortably before actual expiry.
        oauthTokenExpiresAt: String(Date.now() + 12 * 60 * 60 * 1000),
      };

      const result = await ensureFreshOAuthToken({
        ...makeParams(keyVaults),
        config: wideSkewConfig,
      });

      expect(result).toBe(keyVaults);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('retries once the backoff window has elapsed', async () => {
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );

      const result = await ensureFreshOAuthToken({
        ...makeParams({
          oauthAccessToken: 'at-old',
          oauthLastRefreshAt: String(Date.now()),
          oauthLastRefreshErrorAt: String(Date.now() - 6 * 60 * 1000),
          oauthRefreshToken: 'rt-old',
          oauthTokenExpiresAt: String(Date.now() + 12 * 60 * 60 * 1000),
        }),
        config: wideSkewConfig,
      });

      expect(result.oauthAccessToken).toBe('at-new');
      // Success clears the backoff stamp in the same durable write.
      expect(result.oauthLastRefreshErrorAt).toBeUndefined();
      expect(mockUpdateConfig).toHaveBeenCalledWith(
        'supergrok',
        expect.objectContaining({
          keyVaults: expect.objectContaining({ oauthLastRefreshErrorAt: undefined }),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    /**
     * The failure path used to persist the WHOLE captured vault with the stamp appended.
     * `updateConfig` merges explicit leaves over the current row without a CAS, so a
     * request that failed slowly could write its stale (already consumed) token pair back
     * over another process's successful rotation — resurrecting a dead refresh token and
     * taking the connection down until the user reconnects by hand.
     */
    describe('racing a concurrent successful rotation', () => {
      const failingVault = () => ({
        oauthAccessToken: 'at-old',
        oauthLastRefreshAt: String(Date.now()),
        oauthRefreshToken: 'rt-old',
        oauthTokenExpiresAt: String(Date.now() - 1000),
      });

      it('writes nothing at all when the winner already rotated the pair', async () => {
        mockFetch.mockResolvedValueOnce(tokenResponse({ error: 'server_error' }, false));
        // The concurrent success landed while our token call was in flight.
        mockGetAiProviderById.mockResolvedValue({
          keyVaults: {
            oauthAccessToken: 'at-winner',
            oauthLastRefreshAt: String(Date.now()),
            oauthRefreshToken: 'rt-winner',
            oauthTokenExpiresAt: String(Date.now() + 60 * 60 * 1000),
          },
        });

        await expect(ensureFreshOAuthToken(makeParams(failingVault()))).rejects.toThrow();

        // Neither the stale pair NOR a backoff stamp: the winner deliberately cleared the
        // stamp, and re-arming it would suppress refreshes for a credential that works.
        expect(mockUpdateConfig).not.toHaveBeenCalled();
      });

      it('stamps only the error leaf when durable state still holds the failed token', async () => {
        mockFetch.mockResolvedValueOnce(tokenResponse({ error: 'server_error' }, false));
        mockGetAiProviderById.mockResolvedValue({ keyVaults: failingVault() });

        await expect(ensureFreshOAuthToken(makeParams(failingVault()))).rejects.toThrow();

        expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
        expect(mockUpdateConfig).toHaveBeenCalledWith(
          'supergrok',
          { keyVaults: { oauthLastRefreshErrorAt: expect.any(String) } },
          expect.anything(),
          expect.anything(),
        );
      });

      it('never restores the rejected pair when the invalid_grant retry fails transiently', async () => {
        mockFetch
          .mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, false))
          .mockResolvedValueOnce(tokenResponse({ error: 'server_error' }, false));
        // Another instance rotated to a pair that is itself already stale, so the flow
        // re-reads it, retries with it — and that retry fails transiently.
        mockGetAiProviderById.mockResolvedValue({
          keyVaults: {
            oauthAccessToken: 'at-rotated',
            oauthRefreshToken: 'rt-rotated',
            oauthTokenExpiresAt: String(Date.now() - 1000),
          },
        });

        await expect(ensureFreshOAuthToken(makeParams(failingVault()))).rejects.toThrow();

        const [, retryInit] = mockFetch.mock.calls[1];
        expect(retryInit.body).toContain('refresh_token=rt-rotated');
        // The stamp is keyed to the token the RETRY presented, and carries no token leaf —
        // the rejected `rt-old` must never make it back into durable state.
        expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
        expect(mockUpdateConfig).toHaveBeenCalledWith(
          'supergrok',
          { keyVaults: { oauthLastRefreshErrorAt: expect.any(String) } },
          expect.anything(),
          expect.anything(),
        );
        expect(JSON.stringify(mockUpdateConfig.mock.calls)).not.toContain('rt-old');
      });

      it('skips the stamp when the pair rotates again between the retry and the stamp', async () => {
        mockFetch
          .mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, false))
          .mockResolvedValueOnce(tokenResponse({ error: 'server_error' }, false));
        mockGetAiProviderById
          // self-heal re-read
          .mockResolvedValueOnce({
            keyVaults: {
              oauthAccessToken: 'at-rotated',
              oauthRefreshToken: 'rt-rotated',
              oauthTokenExpiresAt: String(Date.now() - 1000),
            },
          })
          // by the time the stamp re-reads, a third writer has rotated again
          .mockResolvedValue({
            keyVaults: {
              oauthAccessToken: 'at-third',
              oauthLastRefreshAt: String(Date.now()),
              oauthRefreshToken: 'rt-third',
              oauthTokenExpiresAt: String(Date.now() + 60 * 60 * 1000),
            },
          });

        await expect(ensureFreshOAuthToken(makeParams(failingVault()))).rejects.toThrow();

        expect(mockUpdateConfig).not.toHaveBeenCalled();
      });
    });

    it('still retries when the access token is already past its expiry', async () => {
      // Backing off here would leave the connection dead for 5 minutes with nothing to
      // fall back on, so an expired token overrides the quiet period.
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );

      const result = await ensureFreshOAuthToken(
        makeParams({
          oauthAccessToken: 'at-old',
          oauthLastRefreshAt: String(Date.now()),
          oauthLastRefreshErrorAt: String(Date.now() - 30 * 1000),
          oauthRefreshToken: 'rt-old',
          oauthTokenExpiresAt: String(Date.now() - 1000),
        }),
      );

      expect(result.oauthAccessToken).toBe('at-new');
    });
  });
});

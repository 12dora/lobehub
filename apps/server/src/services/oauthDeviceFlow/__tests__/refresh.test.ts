// @vitest-environment node
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
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // The base service sends no UA at all — its presence IS the proof of the override.
    expect(init.headers['User-Agent']).toContain('Chrome/136');
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
});

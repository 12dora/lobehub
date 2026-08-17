// @vitest-environment node
import { AgentRuntimeErrorType } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { refreshSharedOAuthVault } from './sharedOAuthRefresh';

const { mockCas, mockGetVersion } = vi.hoisted(() => ({
  mockCas: vi.fn(),
  mockGetVersion: vi.fn(),
}));

vi.mock('@/database/repositories/platformAiCatalog', () => ({
  PlatformAiCatalogRepository: class {
    casProviderSecretCiphertext = mockCas;
    getProviderSecretVersion = mockGetVersion;
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

/**
 * ChatGPT Web's web-session renewal goes through the impersonate transport (chatgpt.com
 * answers Node's own fetch with a bot challenge), which spawns a real child process — so the
 * transport is the seam here too.
 */
const { mockTransportFetch } = vi.hoisted(() => ({ mockTransportFetch: vi.fn() }));

vi.mock('../chatgptWeb/transport', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getChatGPTWebFetch: () => mockTransportFetch,
}));

/** Chainable drizzle stub: db.update().set().where().returning() resolves claimResult. */
const makeDb = (claimResult: Array<{ id: string }>) => {
  const chain = {
    onConflictDoNothing: () => Promise.resolve(),
    returning: () => Promise.resolve(claimResult),
    set: () => chain,
    values: () => chain,
    where: () => chain,
  };
  return { insert: () => chain, update: () => chain } as any;
};

const encryptVault = (vault: object) => `enc:${JSON.stringify(vault)}`;
const decryptVault = (ciphertext: string) => JSON.parse(ciphertext.replace(/^enc:/, ''));

const secrets = {
  decrypt: (ciphertext: string) => Promise.resolve(decryptVault(ciphertext)),
  encryptVaultForRotation: (vault: object) =>
    Promise.resolve({ ciphertext: encryptVault(vault), keyId: 'kek-1' }),
} as any;

const tokenResponse = (body: object, ok = true) => ({
  json: () => Promise.resolve(body),
  ok,
  status: ok ? 200 : 400,
});

const EXPIRING_AT = () => String(Date.now() + 30_000); // inside the 120s refresh skew
const FRESH_AT = () => String(Date.now() + 3_600_000);

const baseVault = (expiresAt: string) => ({
  oauthAccessToken: 'at-old',
  // Recent keepalive anchor, so only the expiry knob decides whether these cases refresh.
  oauthLastRefreshAt: String(Date.now()),
  oauthRefreshToken: 'rt-old',
  oauthTokenExpiresAt: expiresAt,
  // Unrelated leaf that must survive the rotation merge untouched.
  baseURL: 'https://keep.example.com/v1',
});

const makeParams = (overrides: Partial<Parameters<typeof refreshSharedOAuthVault>[0]> = {}) => ({
  ciphertext: encryptVault(baseVault(EXPIRING_AT())),
  db: makeDb([{ id: 'job-1' }]),
  fingerprint: 'sha256:stable',
  keyVaults: baseVault(EXPIRING_AT()),
  providerKey: 'supergrok',
  providerRowId: 'prov_row_1',
  secrets,
  ...overrides,
});

describe('refreshSharedOAuthVault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Implementations too, not just call history: the lease holder now re-reads durable state
    // before refreshing, so a stub leaking across tests would silently change which refresh
    // token the next test sends — and `clearAllMocks` only clears call records.
    mockGetVersion.mockReset();
    mockCas.mockReset();
    mockFetch.mockReset();
  });

  it('never calls the token endpoint with a refresh token a prior lease holder consumed', async () => {
    // The grant-killer race: this requester decrypted an expiring vault, then stalled behind
    // the lease. By the time it acquires, another instance has rotated and released. Sending
    // the pre-lock (now consumed) rotating token is REUSE — providers answer that by revoking
    // the whole grant family, killing the shared credential for everyone.
    const rotated = {
      ...baseVault(FRESH_AT()),
      oauthAccessToken: 'at-rotated-by-other',
      oauthRefreshToken: 'rt-rotated-by-other',
    };
    mockGetVersion.mockResolvedValue({ ciphertext: encryptVault(rotated), keyId: 'kek-1' });

    const result = await refreshSharedOAuthVault(makeParams());

    // No token call at all — the durable re-read under the lease already had a fresh pair.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCas).not.toHaveBeenCalled();
    expect(result.oauthAccessToken).toBe('at-rotated-by-other');
    expect(result.oauthRefreshToken).toBe('rt-rotated-by-other');
  });

  it('refreshes with the re-read refresh token, not the stale pre-lock snapshot', async () => {
    // Same race, but the pair another instance persisted is ALSO expiring, so a token call is
    // genuinely required. It must use what durable state holds now.
    const rotatedButExpiring = {
      ...baseVault(EXPIRING_AT()),
      oauthAccessToken: 'at-newer',
      oauthRefreshToken: 'rt-newer',
    };
    mockGetVersion.mockResolvedValue({
      ciphertext: encryptVault(rotatedButExpiring),
      keyId: 'kek-1',
    });
    mockCas.mockResolvedValue(true);
    mockFetch.mockResolvedValue(
      tokenResponse({
        access_token: 'at-final',
        expires_in: 3600,
        refresh_token: 'rt-final',
        token_type: 'bearer',
      }),
    );

    const result = await refreshSharedOAuthVault(makeParams());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = String((mockFetch.mock.calls[0]?.[1] as { body?: unknown })?.body ?? '');
    expect(body).toContain('rt-newer');
    // The consumed predecessor must never reach the token endpoint.
    expect(body).not.toContain('rt-old');
    expect(result.oauthAccessToken).toBe('at-final');
  });

  it('is a no-op for providers without a rotating refresh grant', async () => {
    const vault = { apiKey: 'sk-x' };
    const result = await refreshSharedOAuthVault(
      makeParams({ keyVaults: vault, providerKey: 'openai' }),
    );
    expect(result).toBe(vault);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is a no-op when the vault has no OAuth token pair', async () => {
    const vault = { oauthAccessToken: 'at-only' };
    const result = await refreshSharedOAuthVault(makeParams({ keyVaults: vault }));
    expect(result).toBe(vault);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is a no-op when the access token is not near expiry', async () => {
    const vault = baseVault(FRESH_AT());
    const result = await refreshSharedOAuthVault(makeParams({ keyVaults: vault }));
    expect(result).toBe(vault);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes with the lease held and CAS-persists the merged vault at the stable fingerprint', async () => {
    mockFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
    );
    mockCas.mockResolvedValueOnce(true);

    const params = makeParams();
    const result = await refreshSharedOAuthVault(params);

    expect(result.oauthAccessToken).toBe('at-new');
    expect(result.oauthRefreshToken).toBe('rt-new');
    expect(result.baseURL).toBe('https://keep.example.com/v1');
    expect(typeof result.oauthTokenExpiresAt).toBe('string');

    expect(mockCas).toHaveBeenCalledTimes(1);
    const casArgs = mockCas.mock.calls[0][0];
    expect(casArgs.fingerprint).toBe('sha256:stable');
    expect(casArgs.providerId).toBe('prov_row_1');
    expect(casArgs.expectedCiphertext).toBe(params.ciphertext);
    const persisted = decryptVault(casArgs.ciphertext);
    expect(persisted.oauthRefreshToken).toBe('rt-new');
    expect(persisted.baseURL).toBe('https://keep.example.com/v1');
  });

  /**
   * The shared path reaches the same refresh policy as the personal one, so a provider that
   * overrides the token wire must be selected HERE too — the base service would send no
   * User-Agent and would surface the provider's `error_description`.
   */
  it('uses the ChatGPT Web override for the shared chatgptweb credential', async () => {
    mockFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
    );
    mockCas.mockResolvedValueOnce(true);

    const result = await refreshSharedOAuthVault(makeParams({ providerKey: 'chatgptweb' }));

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect(init.headers['user-agent']).toContain('Chrome/150');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toContain('grant_type=refresh_token');
    expect(init.body).toContain('refresh_token=rt-old');
    // Bounded strictly below LEASE_SECONDS so the lease cannot expire mid-call.
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(result.oauthAccessToken).toBe('at-new');
    expect(result.oauthRefreshToken).toBe('rt-new');
    expect(decryptVault(mockCas.mock.calls[0][0].ciphertext).oauthRefreshToken).toBe('rt-new');
  });

  /**
   * The re-read UNDER THE LEASE is the snapshot the refresh actually runs on, so every leaf
   * the renewal SPENDS has to survive the platform-vault projection. Dropping the kind would
   * present a session cookie at the OAuth token endpoint; dropping the device id would make
   * every shared renewal look like a brand-new device to the upstream bot filter.
   */
  it('carries the renewal kind AND the device id through the platform re-read', async () => {
    /** next-auth compact JWE: `dir` header, empty encrypted-key segment. */
    const sessionJwe = [
      Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url'),
      '',
      'aXY',
      'Y3Q',
      'dGFn',
    ].join('.');
    const sessionVault = {
      ...baseVault(EXPIRING_AT()),
      oauthDeviceId: 'a3f7c0f7-6f6e-4a1b-9c2d-8e5a1b2c3d4e',
      oauthRefreshToken: sessionJwe,
      oauthRenewalKind: 'web_session',
    };
    mockGetVersion.mockResolvedValue({ ciphertext: encryptVault(sessionVault), keyId: 'kek-1' });
    mockTransportFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'at-new' }), {
        headers: new Headers({
          'content-type': 'application/json',
          'set-cookie': '__Secure-next-auth.session-token=session-rotated; Path=/',
        }),
        status: 200,
      }),
    );
    mockCas.mockResolvedValueOnce(true);

    const result = await refreshSharedOAuthVault(
      makeParams({
        ciphertext: encryptVault(sessionVault),
        keyVaults: sessionVault,
        providerKey: 'chatgptweb',
      }),
    );

    // The session endpoint, not the OAuth token endpoint.
    expect(mockFetch).not.toHaveBeenCalled();
    const [url, init] = mockTransportFetch.mock.calls[0];
    expect(String(url)).toBe('https://chatgpt.com/api/auth/session');
    expect(init.headers.cookie).toBe(
      `oai-did=a3f7c0f7-6f6e-4a1b-9c2d-8e5a1b2c3d4e; __Secure-next-auth.session-token=${sessionJwe}`,
    );
    expect(result.oauthRefreshToken).toBe('session-rotated');
    // The label and the device id survive the merge that persists the rotation.
    expect(result.oauthRenewalKind).toBe('web_session');
    expect(result.oauthDeviceId).toBe('a3f7c0f7-6f6e-4a1b-9c2d-8e5a1b2c3d4e');
  });

  it('never surfaces the provider error_description for the shared chatgptweb credential', async () => {
    mockFetch.mockResolvedValue(
      tokenResponse(
        { error: 'server_error', error_description: 'REQUEST-ECHO rt-old rejected' },
        false,
      ),
    );

    await expect(
      refreshSharedOAuthVault(makeParams({ providerKey: 'chatgptweb' })),
    ).rejects.toMatchObject({ message: expect.not.stringContaining('REQUEST-ECHO') });
  });

  it('survives losing the CAS race to the KEK rewrap worker (same plaintext, new ciphertext)', async () => {
    mockFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
    );
    // First CAS loses to the rewrap worker; the re-read shows the SAME refresh token
    // under a new ciphertext, so the store re-baselines and the second CAS lands.
    // (Before this behavior existed, the rotated pair was dropped after rt-old was
    // already consumed at the provider — killing the shared grant platform-wide.)
    mockCas.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const rewrappedCiphertext = encryptVault(baseVault(EXPIRING_AT()));
    mockGetVersion.mockResolvedValue({ ciphertext: rewrappedCiphertext, keyId: 'kek-2' });

    const result = await refreshSharedOAuthVault(makeParams());
    expect(result.oauthAccessToken).toBe('at-new');
    expect(result.oauthRefreshToken).toBe('rt-new');
    expect(mockCas).toHaveBeenCalledTimes(2);
    // The retry CAS expects the rewrap worker's ciphertext, not the stale baseline.
    expect(mockCas.mock.calls[1][0].expectedCiphertext).toBe(rewrappedCiphertext);
  });

  it('adopts another instance’s rotated pair after a CAS miss instead of failing', async () => {
    mockFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'at-mine', expires_in: 3600, refresh_token: 'rt-mine' }),
    );
    // Every persist attempt loses the CAS race...
    mockCas.mockResolvedValue(false);
    // ...and the durable store already holds the winner's fresh pair.
    mockGetVersion.mockResolvedValue({
      ciphertext: encryptVault({
        oauthAccessToken: 'at-winner',
        oauthLastRefreshAt: String(Date.now()),
        oauthRefreshToken: 'rt-winner',
        oauthTokenExpiresAt: FRESH_AT(),
      }),
      keyId: 'kek-1',
    });

    const result = await refreshSharedOAuthVault(makeParams());
    expect(result.oauthAccessToken).toBe('at-winner');
    expect(result.oauthRefreshToken).toBe('rt-winner');
  });

  it('waits for the lease holder and returns its rotated pair without calling the token endpoint', async () => {
    // Lease claim loses (returning [] from the update chain).
    const db = makeDb([]);
    mockGetVersion.mockResolvedValue({
      ciphertext: encryptVault({
        oauthAccessToken: 'at-holder',
        oauthLastRefreshAt: String(Date.now()),
        oauthRefreshToken: 'rt-holder',
        oauthTokenExpiresAt: FRESH_AT(),
      }),
      keyId: 'kek-1',
    });

    const result = await refreshSharedOAuthVault(makeParams({ db }));
    expect(result.oauthAccessToken).toBe('at-holder');
    expect(mockFetch).not.toHaveBeenCalled();
  }, 15_000);

  /**
   * The refresh-lifecycle stamps have to reach the SHARED vault too — they are what the
   * keepalive sweep reads to decide who is due, and a sweep that cannot see them would
   * force-renew every shared connection on every tick.
   */
  describe('refresh lifecycle bookkeeping', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it('stamps the keepalive anchor and clears the error stamp on a successful rotation', async () => {
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );
      mockCas.mockResolvedValueOnce(true);

      const vault = {
        ...baseVault(EXPIRING_AT()),
        oauthLastRefreshErrorAt: String(Date.now() - 10 * 60 * 1000),
      };
      const result = await refreshSharedOAuthVault(
        makeParams({ ciphertext: encryptVault(vault), keyVaults: vault }),
      );

      const persisted = decryptVault(mockCas.mock.calls[0][0].ciphertext);
      expect(Number(persisted.oauthLastRefreshAt)).toBeGreaterThan(Date.now() - 5000);
      // A leftover error stamp would back off every future attempt for the vault's lifetime.
      expect(persisted).not.toHaveProperty('oauthLastRefreshErrorAt');
      expect(result).not.toHaveProperty('oauthLastRefreshErrorAt');
    });

    it('persists the backoff stamp without touching the token pair when a refresh fails', async () => {
      mockFetch.mockResolvedValue(tokenResponse({ error: 'server_error' }, false));
      mockCas.mockResolvedValue(true);
      // Durable state still holds the credential that failed, so the stamp applies to it.
      mockGetVersion.mockResolvedValue({
        ciphertext: encryptVault(baseVault(EXPIRING_AT())),
        keyId: 'kek-1',
      });

      await expect(refreshSharedOAuthVault(makeParams())).rejects.toThrow();

      const persisted = decryptVault(mockCas.mock.calls.at(-1)![0].ciphertext);
      expect(Number(persisted.oauthLastRefreshErrorAt)).toBeGreaterThan(Date.now() - 5000);
      // Preserved by the merge base, never by the stamp writing a captured copy back.
      expect(persisted.oauthAccessToken).toBe('at-old');
      expect(persisted.oauthRefreshToken).toBe('rt-old');
    });

    it('does not stamp a failure over another holder’s rotation', async () => {
      mockFetch.mockResolvedValue(tokenResponse({ error: 'server_error' }, false));
      mockCas.mockResolvedValue(true);
      const stale = baseVault(EXPIRING_AT());
      // Under the lease the flow re-reads and refreshes with `rt-under-lease`; by the time
      // the failure is stamped, yet another writer has rotated the grant again.
      mockGetVersion
        .mockResolvedValueOnce({
          ciphertext: encryptVault({ ...stale, oauthRefreshToken: 'rt-under-lease' }),
          keyId: 'kek-1',
        })
        .mockResolvedValue({
          ciphertext: encryptVault({ ...baseVault(FRESH_AT()), oauthRefreshToken: 'rt-winner' }),
          keyId: 'kek-1',
        });

      await expect(
        refreshSharedOAuthVault(makeParams({ ciphertext: encryptVault(stale), keyVaults: stale })),
      ).rejects.toThrow();

      // Re-arming the backoff would suppress refreshes for the pair that just succeeded.
      expect(mockCas).not.toHaveBeenCalled();
    });

    it('force-renews a still-valid shared credential for the keepalive sweep', async () => {
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );
      mockCas.mockResolvedValueOnce(true);

      const vault = {
        ...baseVault(FRESH_AT()),
        oauthLastRefreshAt: String(Date.now() - 4 * DAY_MS),
      };
      // Same vault in durable state, so the under-lease re-read cannot short-circuit it.
      mockGetVersion.mockResolvedValue({ ciphertext: encryptVault(vault), keyId: 'kek-1' });

      const result = await refreshSharedOAuthVault(
        makeParams({ ciphertext: encryptVault(vault), force: true, keyVaults: vault }),
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.oauthRefreshToken).toBe('rt-new');
    });

    it('adopts a keepalive another holder just completed instead of renewing again', async () => {
      const vault = {
        ...baseVault(FRESH_AT()),
        oauthLastRefreshAt: String(Date.now() - 4 * DAY_MS),
      };
      // The holder that won the lease already renewed and stamped a fresh anchor.
      mockGetVersion.mockResolvedValue({
        ciphertext: encryptVault({ ...baseVault(FRESH_AT()), oauthRefreshToken: 'rt-holder' }),
        keyId: 'kek-1',
      });

      const result = await refreshSharedOAuthVault(
        makeParams({ ciphertext: encryptVault(vault), force: true, keyVaults: vault }),
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.oauthRefreshToken).toBe('rt-holder');
    });

    it('respects the failure backoff even when the sweep forces a keepalive', async () => {
      const vault = {
        ...baseVault(FRESH_AT()),
        oauthLastRefreshAt: String(Date.now() - 4 * DAY_MS),
        oauthLastRefreshErrorAt: String(Date.now() - 60 * 1000),
      };

      const result = await refreshSharedOAuthVault(
        makeParams({ ciphertext: encryptVault(vault), force: true, keyVaults: vault }),
      );

      expect(result).toBe(vault);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  it('surfaces an admin-facing error when the shared grant is irrecoverably dead', async () => {
    mockFetch.mockResolvedValue(tokenResponse({ error: 'invalid_grant' }, false));
    // Store still holds the same consumed refresh token → truly dead.
    mockGetVersion.mockResolvedValue({
      ciphertext: encryptVault(baseVault(EXPIRING_AT())),
      keyId: 'kek-1',
    });

    await expect(refreshSharedOAuthVault(makeParams())).rejects.toMatchObject({
      errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired,
    });
  });

  /**
   * The admin card used to report a dead shared account as healthy: this refresh is a no-op
   * while the stored access token is not near expiry, and the terminal failure was only ever
   * logged. The marker is what closes that gap — and it must never cost the vault its evidence.
   */
  describe('reauth marker', () => {
    it('records a dead grant in the vault without clearing it', async () => {
      mockFetch.mockResolvedValue(tokenResponse({ error: 'invalid_grant' }, false));
      mockGetVersion.mockResolvedValue({
        ciphertext: encryptVault(baseVault(EXPIRING_AT())),
        keyId: 'kek-1',
      });
      mockCas.mockResolvedValue(true);

      await expect(refreshSharedOAuthVault(makeParams())).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired,
      });

      const persisted = decryptVault(mockCas.mock.calls.at(-1)![0].ciphertext);
      expect(persisted.oauthGrantInvalidReason).toBe('invalidGrant');
      expect(Number(persisted.oauthGrantInvalidAt)).toBeGreaterThan(Date.now() - 5000);
      // The credential IS the evidence: the marker never replaces it.
      expect(persisted.oauthAccessToken).toBe('at-old');
      expect(persisted.oauthRefreshToken).toBe('rt-old');
      expect(persisted.baseURL).toBe('https://keep.example.com/v1');
      // The fingerprint is revision-pinned; a marker may not move it.
      expect(mockCas.mock.calls.at(-1)![0].fingerprint).toBe('sha256:stable');
    });

    it('leaves no marker behind when the failure is transient', async () => {
      // A token endpoint 5xx (like a Cloudflare challenge or a rate limit) says nothing about
      // whether the grant is still valid.
      mockFetch.mockResolvedValue(tokenResponse({ error: 'server_error' }, false));
      mockGetVersion.mockResolvedValue({
        ciphertext: encryptVault(baseVault(EXPIRING_AT())),
        keyId: 'kek-1',
      });
      mockCas.mockResolvedValue(true);

      await expect(refreshSharedOAuthVault(makeParams())).rejects.toThrow();

      for (const call of mockCas.mock.calls) {
        expect(decryptVault(call[0].ciphertext)).not.toHaveProperty('oauthGrantInvalidAt');
      }
    });

    it('keeps a durable marker when the lock path merely adopts another holder’s tokens', async () => {
      // No rotation was persisted here, so nothing PROVES the grant recovered. Clearing the
      // marker in this response would make getConnectionStatus report healthy (and SWR cache
      // it) while durable state still says the account must be re-authorized.
      const adopted = {
        ...baseVault(FRESH_AT()),
        oauthAccessToken: 'at-rotated-by-other',
        oauthGrantInvalidAt: String(Date.now() - 60_000),
        oauthGrantInvalidReason: 'runtimeAuth',
        oauthRefreshToken: 'rt-rotated-by-other',
      };
      mockGetVersion.mockResolvedValue({ ciphertext: encryptVault(adopted), keyId: 'kek-1' });

      const result = await refreshSharedOAuthVault(makeParams());

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockCas).not.toHaveBeenCalled();
      expect(result.oauthAccessToken).toBe('at-rotated-by-other');
      expect(result.oauthGrantInvalidReason).toBe('runtimeAuth');
    });

    it('clears the marker on the next successful rotation', async () => {
      mockFetch.mockResolvedValueOnce(
        tokenResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
      );
      mockCas.mockResolvedValueOnce(true);
      const vault = {
        ...baseVault(EXPIRING_AT()),
        oauthGrantInvalidAt: String(Date.now() - 60_000),
        oauthGrantInvalidReason: 'runtimeAuth',
      };

      const result = await refreshSharedOAuthVault(
        makeParams({ ciphertext: encryptVault(vault), keyVaults: vault }),
      );

      const persisted = decryptVault(mockCas.mock.calls[0][0].ciphertext);
      // The provider just accepted the renewal credential — that is the recovery proof.
      expect(persisted).not.toHaveProperty('oauthGrantInvalidAt');
      expect(persisted).not.toHaveProperty('oauthGrantInvalidReason');
      expect(result).not.toHaveProperty('oauthGrantInvalidAt');
      expect(result).not.toHaveProperty('oauthGrantInvalidReason');
    });
  });
});

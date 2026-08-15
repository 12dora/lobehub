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
    expect(init.headers['User-Agent']).toContain('Chrome/136');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toContain('grant_type=refresh_token');
    expect(init.body).toContain('refresh_token=rt-old');
    // Bounded strictly below LEASE_SECONDS so the lease cannot expire mid-call.
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(result.oauthAccessToken).toBe('at-new');
    expect(result.oauthRefreshToken).toBe('rt-new');
    expect(decryptVault(mockCas.mock.calls[0][0].ciphertext).oauthRefreshToken).toBe('rt-new');
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
        oauthRefreshToken: 'rt-holder',
        oauthTokenExpiresAt: FRESH_AT(),
      }),
      keyId: 'kek-1',
    });

    const result = await refreshSharedOAuthVault(makeParams({ db }));
    expect(result.oauthAccessToken).toBe('at-holder');
    expect(mockFetch).not.toHaveBeenCalled();
  }, 15_000);

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
});

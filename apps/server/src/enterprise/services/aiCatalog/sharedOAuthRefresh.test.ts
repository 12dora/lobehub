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

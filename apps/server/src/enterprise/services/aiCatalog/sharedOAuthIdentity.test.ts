// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiCatalogSecretManager } from './secretManager';
import {
  persistSharedOAuthIdentityLeaves,
  resetSharedAccountIdentityBackfillForTests,
  SHARED_ACCOUNT_IDENTITY_BACKFILL_COOLDOWN_MS,
  tryBackfillSharedAccountIdentity,
} from './sharedOAuthIdentity';

const { mockCas, mockGetProvider } = vi.hoisted(() => ({
  mockCas: vi.fn(),
  mockGetProvider: vi.fn(),
}));

vi.mock('@/database/repositories/platformAiCatalog', () => ({
  PlatformAiCatalogRepository: class {
    casProviderSecretCiphertext = mockCas;
    getProvider = mockGetProvider;
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const accessToken = 'opaque-xai-token';
const keyVaults = { oauthAccessToken: accessToken, oauthRefreshToken: 'rt-1' };

const mockDecrypt = vi.fn(async (ciphertext: string) => {
  if (ciphertext === 'ct-old') {
    return { oauthAccessToken: 'at-old', oauthRefreshToken: 'rt-old' };
  }
  return keyVaults;
});

const secrets = {
  decrypt: mockDecrypt,
  encryptVaultForRotation: (vault: object) =>
    Promise.resolve({ ciphertext: `enc:${JSON.stringify(vault)}`, keyId: 'kek-1' }),
} as unknown as AiCatalogSecretManager;

const makeBackfill = (
  overrides: Partial<Parameters<typeof tryBackfillSharedAccountIdentity>[0]> = {},
) =>
  tryBackfillSharedAccountIdentity({
    db: {} as never,
    providerKey: 'supergrok',
    providerRowId: 'prov_row_1',
    secrets,
    ...overrides,
  });

describe('tryBackfillSharedAccountIdentity', () => {
  beforeEach(() => {
    resetSharedAccountIdentityBackfillForTests();
    mockCas.mockReset();
    mockFetch.mockReset();
    mockGetProvider.mockReset();
    mockGetProvider.mockResolvedValue({
      encryptedKeyVaults: 'ct-1',
      secretFingerprint: 'sha256:stable',
    });
    mockDecrypt.mockClear();
  });

  afterEach(() => {
    resetSharedAccountIdentityBackfillForTests();
  });

  it('persists userinfo identity when the vault has no email leaf', async () => {
    mockCas.mockResolvedValueOnce(true);
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          email: 'user@example.com',
          email_verified: true,
          sub: '81f4abc',
        }),
      ok: true,
      status: 200,
    });

    const identity = await makeBackfill();

    expect(identity).toEqual({ accountId: '81f4abc', email: 'user@example.com' });
    expect(mockCas).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCiphertext: 'ct-1',
        fingerprint: 'sha256:stable',
        providerId: 'prov_row_1',
      }),
    );
    expect(mockCas.mock.calls[0][0].ciphertext).toContain('user@example.com');
  });

  it('returns fetched identity when CAS loses, without throwing', async () => {
    mockCas.mockResolvedValueOnce(false);
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ email: 'user@example.com', sub: '81f4abc' }),
      ok: true,
      status: 200,
    });

    await expect(makeBackfill()).resolves.toEqual({
      accountId: '81f4abc',
      email: 'user@example.com',
    });
  });

  it('returns undefined and does not throw when userinfo fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('userinfo down'));

    await expect(makeBackfill()).resolves.toBeUndefined();
    expect(mockCas).not.toHaveBeenCalled();
  });

  it('does not re-fetch within the cooldown window', async () => {
    mockFetch.mockRejectedValueOnce(new Error('userinfo down'));
    await makeBackfill();
    mockFetch.mockClear();

    await expect(makeBackfill({ now: Date.now() + 60_000 })).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('CASes against the ciphertext it decrypted, so a concurrent rotation cannot be clobbered', async () => {
    mockGetProvider.mockResolvedValue({
      encryptedKeyVaults: 'ct-old',
      secretFingerprint: 'sha256:stable',
    });
    mockCas.mockResolvedValueOnce(false);
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ email: 'user@example.com', sub: '81f4abc' }),
      ok: true,
      status: 200,
    });

    await expect(makeBackfill()).resolves.toEqual({
      accountId: '81f4abc',
      email: 'user@example.com',
    });

    expect(mockDecrypt).toHaveBeenCalledWith('ct-old');
    expect(mockCas).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCiphertext: 'ct-old',
        fingerprint: 'sha256:stable',
      }),
    );
    const persisted = mockCas.mock.calls[0][0].ciphertext as string;
    expect(persisted).toContain('at-old');
    expect(persisted).toContain('rt-old');
    expect(persisted).toContain('user@example.com');
    expect(persisted).not.toContain(accessToken);
  });

  it('prunes cooldown entries older than the window so a later row can fetch again', async () => {
    mockFetch.mockRejectedValue(new Error('userinfo down'));
    await makeBackfill({ providerRowId: 'row-a' });

    const later = Date.now() + SHARED_ACCOUNT_IDENTITY_BACKFILL_COOLDOWN_MS + 1;
    mockFetch.mockClear();
    await makeBackfill({ now: later, providerRowId: 'row-b' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockClear();
    await makeBackfill({ now: later, providerRowId: 'row-a' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('issues only one identity fetch when concurrent callers race the cooldown gate', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockGetProvider.mockImplementation(async () => {
      await gate;
      return { encryptedKeyVaults: 'ct-1', secretFingerprint: 'sha256:stable' };
    });
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ email: 'user@example.com', sub: '81f4abc' }),
      ok: true,
      status: 200,
    });
    mockCas.mockResolvedValue(true);

    const pending = Promise.all([makeBackfill(), makeBackfill()]);
    release();
    await pending;

    expect(mockGetProvider).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('persistSharedOAuthIdentityLeaves', () => {
  beforeEach(() => {
    mockCas.mockReset();
  });

  it('is a no-op when identity is empty', async () => {
    await expect(
      persistSharedOAuthIdentityLeaves({
        ciphertext: 'ct-1',
        db: {} as never,
        fingerprint: 'fp',
        identity: {},
        keyVaults,
        providerRowId: 'row',
        secrets,
      }),
    ).resolves.toBe(false);
    expect(mockCas).not.toHaveBeenCalled();
  });
});

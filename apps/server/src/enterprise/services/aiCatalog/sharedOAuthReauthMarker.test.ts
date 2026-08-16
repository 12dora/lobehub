// @vitest-environment node
import { AgentRuntimeErrorType } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { digestPlatformAiCredential } from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';

import {
  classifyExecutionAuthFailure,
  markSharedOAuthGrantInvalid,
  markSharedOAuthGrantInvalidForProvider,
  OAUTH_GRANT_INVALID_AT_KEY,
  OAUTH_GRANT_INVALID_REASON_KEY,
  readSharedOAuthReauthMarker,
  SHARED_OAUTH_REAUTH_DEBOUNCE_MS,
} from './sharedOAuthReauthMarker';

const { mockCas, mockGetByKey, mockGetVersion } = vi.hoisted(() => ({
  mockCas: vi.fn(),
  mockGetByKey: vi.fn(),
  mockGetVersion: vi.fn(),
}));

vi.mock('@/database/repositories/platformAiCatalog', () => ({
  PlatformAiCatalogRepository: class {
    casProviderSecretCiphertext = mockCas;
    getProviderByKey = mockGetByKey;
    getProviderSecretVersion = mockGetVersion;
  },
}));

const encryptVault = (vault: object) => `enc:${JSON.stringify(vault)}`;
const decryptVault = (ciphertext: string) => JSON.parse(ciphertext.replace(/^enc:/, ''));

const secrets = {
  decrypt: (ciphertext: string) => Promise.resolve(decryptVault(ciphertext)),
  encryptVaultForRotation: (vault: object) =>
    Promise.resolve({ ciphertext: encryptVault(vault), keyId: 'kek-1' }),
} as any;

const baseVault = () => ({
  // An unrelated leaf that must survive the marker write untouched.
  baseURL: 'https://keep.example.com/v1',
  oauthAccessToken: 'at-live',
  oauthRefreshToken: 'rt-live',
  oauthTokenExpiresAt: String(Date.now() + 3_600_000),
});

const makeParams = (overrides: Record<string, unknown> = {}) => ({
  ciphertext: encryptVault(baseVault()),
  db: {} as any,
  fingerprint: 'sha256:stable',
  keyVaults: baseVault(),
  providerRowId: 'prov_row_1',
  reason: 'runtimeAuth' as const,
  secrets,
  ...overrides,
});

beforeEach(() => {
  mockCas.mockReset();
  mockGetByKey.mockReset();
  mockGetVersion.mockReset();
});

describe('markSharedOAuthGrantInvalid', () => {
  it('stamps the marker at the stable fingerprint without touching the credential', async () => {
    mockCas.mockResolvedValueOnce(true);
    const params = makeParams();

    await expect(markSharedOAuthGrantInvalid(params)).resolves.toBe(true);

    expect(mockCas).toHaveBeenCalledTimes(1);
    const args = mockCas.mock.calls[0][0];
    // A published revision pins the fingerprint: a marker write must never change it.
    expect(args.fingerprint).toBe('sha256:stable');
    expect(args.providerId).toBe('prov_row_1');
    expect(args.expectedCiphertext).toBe(params.ciphertext);

    const persisted = decryptVault(args.ciphertext);
    expect(persisted[OAUTH_GRANT_INVALID_REASON_KEY]).toBe('runtimeAuth');
    expect(persisted[OAUTH_GRANT_INVALID_AT_KEY]).toMatch(/^\d+$/);
    // The vault is EVIDENCE — clearing it would destroy the operator's only trace.
    expect(persisted.oauthAccessToken).toBe('at-live');
    expect(persisted.oauthRefreshToken).toBe('rt-live');
    expect(persisted.baseURL).toBe('https://keep.example.com/v1');
  });

  it('does not write again while a recent marker already says so', async () => {
    const now = Date.now();
    const vault = {
      ...baseVault(),
      [OAUTH_GRANT_INVALID_AT_KEY]: String(now - 60_000),
      [OAUTH_GRANT_INVALID_REASON_KEY]: 'invalidGrant',
    };

    // A broken shared account fails EVERY member's request; one CAS write per failure would
    // hammer the secret row for no new information.
    await expect(
      markSharedOAuthGrantInvalid(
        makeParams({ ciphertext: encryptVault(vault), keyVaults: vault }),
      ),
    ).resolves.toBe(false);
    expect(mockCas).not.toHaveBeenCalled();
  });

  it('re-stamps once the marker is older than the debounce window', async () => {
    mockCas.mockResolvedValueOnce(true);
    const now = Date.now();
    const vault = {
      ...baseVault(),
      [OAUTH_GRANT_INVALID_AT_KEY]: String(now - SHARED_OAUTH_REAUTH_DEBOUNCE_MS - 1000),
      [OAUTH_GRANT_INVALID_REASON_KEY]: 'invalidGrant',
    };

    await expect(
      markSharedOAuthGrantInvalid(
        makeParams({ ciphertext: encryptVault(vault), keyVaults: vault, reason: 'runtimeAuth' }),
      ),
    ).resolves.toBe(true);
    const persisted = decryptVault(mockCas.mock.calls[0][0].ciphertext);
    expect(Number(persisted[OAUTH_GRANT_INVALID_AT_KEY])).toBeGreaterThanOrEqual(now);
    expect(persisted[OAUTH_GRANT_INVALID_REASON_KEY]).toBe('runtimeAuth');
  });

  it('survives losing the CAS race to the KEK rewrap worker and retries on the new baseline', async () => {
    // The rewrap worker rewrites the SAME plaintext under a new ciphertext; losing to it must
    // not drop the observation.
    const rewrapped = { ...baseVault(), rewrapped: 'yes' };
    mockCas.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockGetVersion.mockResolvedValue({ ciphertext: encryptVault(rewrapped), keyId: 'kek-2' });

    await expect(markSharedOAuthGrantInvalid(makeParams())).resolves.toBe(true);

    expect(mockCas).toHaveBeenCalledTimes(2);
    expect(mockCas.mock.calls[1][0].expectedCiphertext).toBe(encryptVault(rewrapped));
    expect(decryptVault(mockCas.mock.calls[1][0].ciphertext).rewrapped).toBe('yes');
  });

  it('never marks a credential that was replaced while the write was in flight', async () => {
    // An operator reconnected (or another instance rotated): stamping now would report a
    // brand-new, working credential as dead.
    const reconnected = { ...baseVault(), oauthAccessToken: 'at-brand-new' };
    mockCas.mockResolvedValue(false);
    mockGetVersion.mockResolvedValue({ ciphertext: encryptVault(reconnected), keyId: 'kek-1' });

    await expect(markSharedOAuthGrantInvalid(makeParams())).resolves.toBe(false);
    expect(mockCas).toHaveBeenCalledTimes(1);
  });

  it('gives up quietly when the secret version is gone', async () => {
    mockCas.mockResolvedValue(false);
    mockGetVersion.mockResolvedValue(undefined);

    await expect(markSharedOAuthGrantInvalid(makeParams())).resolves.toBe(false);
  });

  it('never throws — an observation must not become an error of its own', async () => {
    mockCas.mockRejectedValue(new Error('db down'));

    await expect(markSharedOAuthGrantInvalid(makeParams())).resolves.toBe(false);
  });
});

describe('classifyExecutionAuthFailure', () => {
  it.each([
    AgentRuntimeErrorType.OAuthAuthorizationExpired,
    AgentRuntimeErrorType.InvalidProviderAPIKey,
  ])('treats %s as a terminal auth failure', (errorType) => {
    expect(classifyExecutionAuthFailure(errorType)).toBe('runtimeAuth');
  });

  it.each([
    // Cloudflare challenges and upstream hiccups map to these — a card crying wolf over a
    // bad minute is worse than no badge at all.
    AgentRuntimeErrorType.ProviderBizError,
    AgentRuntimeErrorType.RateLimitExceeded,
    AgentRuntimeErrorType.ProviderNetworkError,
    AgentRuntimeErrorType.ModelNotFound,
    AgentRuntimeErrorType.PermissionDenied,
    undefined,
  ])('ignores the transient %s', (errorType) => {
    expect(classifyExecutionAuthFailure(errorType)).toBeNull();
  });
});

describe('markSharedOAuthGrantInvalidForProvider', () => {
  const LIVE_DIGEST = digestPlatformAiCredential('at-live')!;

  const report = (overrides: Record<string, unknown> = {}) =>
    markSharedOAuthGrantInvalidForProvider({
      credentialDigest: LIVE_DIGEST,
      db: {} as any,
      providerKey: 'chatgptweb',
      reason: 'runtimeAuth',
      secrets,
      ...overrides,
    } as any);

  it('marks the shared row resolved from the provider key', async () => {
    mockGetByKey.mockResolvedValue({
      encryptedKeyVaults: encryptVault(baseVault()),
      id: 'prov_row_9',
      secretFingerprint: 'sha256:web',
    });
    mockCas.mockResolvedValueOnce(true);

    await expect(report()).resolves.toBe(true);
    expect(mockCas.mock.calls[0][0].providerId).toBe('prov_row_9');
  });

  /**
   * The race the digest exists for. A request runs on token A; before its 401 comes back an
   * admin reconnects (or a rotation installs) token B. Resolving "the current row" and marking
   * it would tell the operator their BRAND-NEW credential is dead — and the CAS token guard
   * cannot catch it, because by then B is already the baseline.
   */
  it('discards the observation when the operator reconnected in the meantime', async () => {
    mockGetByKey.mockResolvedValue({
      encryptedKeyVaults: encryptVault({ ...baseVault(), oauthAccessToken: 'at-reconnected' }),
      id: 'prov_row_9',
      secretFingerprint: 'sha256:web',
    });

    await expect(report()).resolves.toBe(false);
    expect(mockCas).not.toHaveBeenCalled();
  });

  it('discards the observation when the credential rotated in the meantime', async () => {
    mockGetByKey.mockResolvedValue({
      encryptedKeyVaults: encryptVault({
        ...baseVault(),
        oauthAccessToken: 'at-rotated',
        oauthRefreshToken: 'rt-rotated',
      }),
      id: 'prov_row_9',
      secretFingerprint: 'sha256:web',
    });

    await expect(report()).resolves.toBe(false);
    expect(mockCas).not.toHaveBeenCalled();
  });

  it('never lets an execution pinned to an older revision mark the current credential', async () => {
    // A pinned platform operation keeps running on the revision it started on; its 401 says
    // nothing about the credential the platform is serving everyone else with today.
    mockGetByKey.mockResolvedValue({
      encryptedKeyVaults: encryptVault(baseVault()),
      id: 'prov_row_9',
      secretFingerprint: 'sha256:web',
    });

    await expect(
      report({ credentialDigest: digestPlatformAiCredential('at-of-an-old-revision') }),
    ).resolves.toBe(false);
    expect(mockCas).not.toHaveBeenCalled();
  });

  it('writes nothing without a credential digest to compare against', async () => {
    await expect(report({ credentialDigest: undefined })).resolves.toBe(false);
    expect(mockGetByKey).not.toHaveBeenCalled();
  });

  it('ignores providers that cannot hold a shared OAuth account', async () => {
    await expect(report({ providerKey: 'openai' })).resolves.toBe(false);
    // An API-key provider has no "reconnect" for an administrator to perform.
    expect(mockGetByKey).not.toHaveBeenCalled();
  });

  it('ignores a row with no stored shared credential', async () => {
    mockGetByKey.mockResolvedValue({
      encryptedKeyVaults: encryptVault({ apiKey: 'sk-x' }),
      id: 'prov_row_9',
      secretFingerprint: 'sha256:web',
    });

    await expect(report()).resolves.toBe(false);
    expect(mockCas).not.toHaveBeenCalled();
  });
});

describe('digestPlatformAiCredential', () => {
  it('is stable, opaque and never the token itself', () => {
    const digest = digestPlatformAiCredential('at-live')!;
    expect(digest).toBe(digestPlatformAiCredential('at-live'));
    expect(digest).not.toContain('at-live');
    expect(digest).toHaveLength(22);
    expect(digestPlatformAiCredential('at-other')).not.toBe(digest);
    expect(digestPlatformAiCredential(undefined)).toBeUndefined();
  });
});

describe('readSharedOAuthReauthMarker', () => {
  it('projects the pair, and treats an unknown reason as absent', () => {
    expect(
      readSharedOAuthReauthMarker({
        [OAUTH_GRANT_INVALID_AT_KEY]: '1700000000000',
        [OAUTH_GRANT_INVALID_REASON_KEY]: 'invalidGrant',
      }),
    ).toEqual({ invalidAt: '1700000000000', invalidReason: 'invalidGrant' });

    expect(
      readSharedOAuthReauthMarker({
        [OAUTH_GRANT_INVALID_AT_KEY]: '1700000000000',
        [OAUTH_GRANT_INVALID_REASON_KEY]: 'something-a-future-writer-invented',
      }),
    ).toEqual({ invalidAt: '1700000000000', invalidReason: null });
  });

  it('is empty for a healthy vault, and a lone reason is not a marker', () => {
    expect(readSharedOAuthReauthMarker({ oauthAccessToken: 'at' })).toEqual({
      invalidAt: null,
      invalidReason: null,
    });
    expect(
      readSharedOAuthReauthMarker({ [OAUTH_GRANT_INVALID_REASON_KEY]: 'invalidGrant' }),
    ).toEqual({ invalidAt: null, invalidReason: null });
  });
});

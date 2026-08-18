import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase } from '@/database/type';
import { resolveOAuthAccountIdentity } from '@/server/services/oauthDeviceFlow';
import { fetchCursorAccountIdentity } from '@/server/services/oauthDeviceFlow/providers/cursor';

import type { AiCatalogSecretManager, PlatformProviderKeyVaults } from './secretManager';
import { asPlatformVaultString } from './shared';

const NETWORK_IDENTITY_PROVIDERS = new Set(['cursor', 'grok', 'supergrok']);
const XAI_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';

/** At most one network identity attempt per provider row in this window. */
export const SHARED_ACCOUNT_IDENTITY_BACKFILL_COOLDOWN_MS = 10 * 60 * 1000;

const backfillAttemptedAt = new Map<string, number>();

const pruneBackfillAttempts = (now: number): void => {
  for (const [rowId, attemptedAt] of backfillAttemptedAt) {
    if (now - attemptedAt >= SHARED_ACCOUNT_IDENTITY_BACKFILL_COOLDOWN_MS) {
      backfillAttemptedAt.delete(rowId);
    }
  }
};

export const resetSharedAccountIdentityBackfillForTests = (): void => {
  backfillAttemptedAt.clear();
};

export const hasNetworkAccountIdentitySource = (providerId: string): boolean =>
  NETWORK_IDENTITY_PROVIDERS.has(providerId);

export const fetchSharedAccountIdentity = async (
  providerId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ accountId?: string; email?: string }> => {
  if (providerId === 'cursor') {
    const card = DEFAULT_MODEL_PROVIDER_LIST.find((provider) => provider.id === providerId);
    return fetchCursorAccountIdentity(accessToken, card?.settings?.oauthDeviceFlow, signal);
  }
  if (providerId === 'grok' || providerId === 'supergrok') {
    return resolveOAuthAccountIdentity({
      accessToken,
      signal,
      tokenEndpoint: XAI_TOKEN_ENDPOINT,
    });
  }
  return {};
};

export const persistSharedOAuthIdentityLeaves = async (params: {
  ciphertext: string;
  db: LobeChatDatabase;
  fingerprint: string;
  identity: { accountId?: string; email?: string };
  keyVaults: PlatformProviderKeyVaults;
  providerRowId: string;
  secrets: AiCatalogSecretManager;
}): Promise<boolean> => {
  if (!params.identity.email && !params.identity.accountId) return false;
  try {
    const merged: PlatformProviderKeyVaults = {
      ...params.keyVaults,
      ...(params.identity.accountId ? { oauthAccountId: params.identity.accountId } : {}),
      ...(params.identity.email ? { oauthAccountEmail: params.identity.email } : {}),
    };
    const sealed = await params.secrets.encryptVaultForRotation(merged);
    const updated = await new PlatformAiCatalogRepository(params.db).casProviderSecretCiphertext({
      ciphertext: sealed.ciphertext,
      expectedCiphertext: params.ciphertext,
      fingerprint: params.fingerprint,
      keyId: sealed.keyId,
      providerId: params.providerRowId,
    });
    return Boolean(updated);
  } catch {
    return false;
  }
};

/**
 * One best-effort identity fetch + persist for an existing shared account whose vault
 * predates the email leaf.
 *
 * Always re-reads and decrypts the current secret version, then CAS-writes against
 * THAT ciphertext. Pairing a stale vault snapshot with a newer ciphertext would let
 * CAS succeed while restoring consumed tokens. A lost CAS still returns the fetched
 * identity so this status response can name the account.
 */
export const tryBackfillSharedAccountIdentity = async (params: {
  db: LobeChatDatabase;
  now?: number;
  providerKey: string;
  providerRowId: string;
  secrets: AiCatalogSecretManager;
}): Promise<{ accountId?: string; email?: string } | undefined> => {
  if (!hasNetworkAccountIdentitySource(params.providerKey)) return undefined;

  const now = params.now ?? Date.now();
  pruneBackfillAttempts(now);
  const last = backfillAttemptedAt.get(params.providerRowId);
  if (last !== undefined && now - last < SHARED_ACCOUNT_IDENTITY_BACKFILL_COOLDOWN_MS) {
    return undefined;
  }
  // Reserve before any await so concurrent status reads cannot both pass the gate.
  backfillAttemptedAt.set(params.providerRowId, now);

  try {
    const latest = await new PlatformAiCatalogRepository(params.db).getProvider(
      params.providerRowId,
    );
    const ciphertext = latest?.encryptedKeyVaults;
    const fingerprint = latest?.secretFingerprint;
    if (!ciphertext || !fingerprint) return undefined;

    const keyVaults = await params.secrets.decrypt(ciphertext);
    if (asPlatformVaultString(keyVaults.oauthAccountEmail)) return undefined;
    const accessToken = asPlatformVaultString(keyVaults.oauthAccessToken);
    if (!accessToken) return undefined;

    const identity = await fetchSharedAccountIdentity(params.providerKey, accessToken);
    if (!identity.email && !identity.accountId) return undefined;
    await persistSharedOAuthIdentityLeaves({
      ciphertext,
      db: params.db,
      fingerprint,
      identity,
      keyVaults,
      providerRowId: params.providerRowId,
      secrets: params.secrets,
    });
    return identity;
  } catch {
    return undefined;
  }
};

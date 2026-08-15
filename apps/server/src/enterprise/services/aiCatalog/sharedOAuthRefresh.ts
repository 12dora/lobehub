import { randomUUID } from 'node:crypto';

import { AgentRuntimeError } from '@lobechat/model-runtime';
import { AgentRuntimeErrorType } from '@lobechat/types';
import debug from 'debug';
import { and, eq, sql } from 'drizzle-orm';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import { platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import {
  ensureFreshOAuthTokenWithStore,
  isOAuthTokenExpiring,
  type OAuthTokenKeyVaults,
  type OAuthTokenStore,
} from '@/server/services/oauthDeviceFlow/refresh';

import type { AiCatalogSecretManager, PlatformProviderKeyVaults } from './secretManager';

const log = debug('lobe-server:ai-catalog-shared-oauth');

/**
 * Cross-instance mutex for refreshing a SHARED rotating refresh token. One
 * `platform_jobs` row per provider acts as a reusable lease (never scanned by the
 * persistent worker schedulers, which claim by their own types). The lease must be held
 * across the token-endpoint HTTP call: two instances refreshing with the same rotating
 * token trip the provider's reuse detection, which can revoke the entire grant family
 * and kill the shared credential for every user at once.
 */
export const SHARED_OAUTH_REFRESH_JOB_TYPE = 'platform.ai.oauth.refresh.v1';

/**
 * Lease budget for ONE refresh. It must strictly exceed the token call it protects:
 * `refresh.ts` bounds every token-endpoint request to 20 s (and ChatGPT Web's own override
 * bounds itself to the same), leaving ~10 s for the CAS persist that follows. If the call
 * could outlive the lease, another instance would acquire it and present the SAME rotating
 * refresh token — the reuse providers answer by revoking the entire grant family, killing
 * the shared credential for every user at once. Raising this value is safe; lowering it
 * below the refresh bound is not.
 */
const LEASE_SECONDS = 30;
const WAITER_POLL_INTERVAL_MS = 500;
/** ≤12s of waiting — a refresh round-trip is 1–3s; the 30s lease expiry backstops a crash. */
const WAITER_MAX_POLLS = 24;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const toOAuthVault = (vault: PlatformProviderKeyVaults): OAuthTokenKeyVaults => ({
  oauthAccessToken: asString(vault.oauthAccessToken),
  oauthAccountId: asString(vault.oauthAccountId),
  oauthRefreshToken: asString(vault.oauthRefreshToken),
  oauthTokenExpiresAt: asString(vault.oauthTokenExpiresAt),
});

/** Overlay refreshed token leaves; non-OAuth leaves and unknown keys are preserved. */
const mergeTokens = (
  base: PlatformProviderKeyVaults,
  tokens: OAuthTokenKeyVaults,
): PlatformProviderKeyVaults => ({
  ...base,
  ...(tokens.oauthAccessToken ? { oauthAccessToken: tokens.oauthAccessToken } : {}),
  ...(tokens.oauthAccountId ? { oauthAccountId: tokens.oauthAccountId } : {}),
  ...(tokens.oauthRefreshToken ? { oauthRefreshToken: tokens.oauthRefreshToken } : {}),
  // The platform vault only stores string leaves.
  ...(tokens.oauthTokenExpiresAt === undefined
    ? {}
    : { oauthTokenExpiresAt: String(tokens.oauthTokenExpiresAt) }),
});

/** Matches the payload thrown for a dead shared grant (AgentRuntimeError.createError shape). */
export const isOAuthAuthorizationExpiredError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { errorType?: unknown }).errorType === AgentRuntimeErrorType.OAuthAuthorizationExpired;

const throwSharedGrantExpired = (providerId: string): never => {
  // Surfaced to end users who cannot fix it themselves — point them at the admin, and
  // leave an operator trace (the vault is deliberately NOT cleared; it is the evidence).
  console.error(
    `[ai-catalog-shared-oauth] shared ${providerId} connection is dead (invalid_grant); ` +
      'a platform administrator must reconnect it from the admin providers page',
  );
  throw AgentRuntimeError.createError(AgentRuntimeErrorType.OAuthAuthorizationExpired, {
    message:
      'The shared provider connection has expired. Ask a platform administrator to reconnect it from the admin providers page.',
  });
};

const claimRefreshLease = async (
  db: LobeChatDatabase,
  providerKey: string,
  owner: string,
): Promise<boolean> => {
  await db
    .insert(platformJobs)
    .values({ idempotencyKey: providerKey, type: SHARED_OAUTH_REFRESH_JOB_TYPE })
    .onConflictDoNothing();
  const rows = await db
    .update(platformJobs)
    .set({
      attempt: sql`${platformJobs.attempt} + 1`,
      heartbeatAt: sql`clock_timestamp()`,
      leaseOwner: owner,
      // DB clock, not process clock — instances' clocks are not trusted to agree.
      leaseUntil: sql`clock_timestamp() + make_interval(secs => ${LEASE_SECONDS})`,
      startedAt: sql`coalesce(${platformJobs.startedAt}, clock_timestamp())`,
      status: 'running',
    })
    .where(
      and(
        eq(platformJobs.type, SHARED_OAUTH_REFRESH_JOB_TYPE),
        eq(platformJobs.idempotencyKey, providerKey),
        sql`(${platformJobs.leaseUntil} IS NULL OR ${platformJobs.leaseUntil} < clock_timestamp())`,
      ),
    )
    .returning({ id: platformJobs.id });
  return rows.length > 0;
};

const releaseRefreshLease = async (
  db: LobeChatDatabase,
  providerKey: string,
  owner: string,
): Promise<void> => {
  await db
    .update(platformJobs)
    .set({ finishedAt: new Date(), leaseOwner: null, leaseUntil: null, status: 'succeeded' })
    .where(
      and(
        eq(platformJobs.type, SHARED_OAUTH_REFRESH_JOB_TYPE),
        eq(platformJobs.idempotencyKey, providerKey),
        eq(platformJobs.leaseOwner, owner),
      ),
    );
};

export interface RefreshSharedOAuthVaultParams {
  /** Ciphertext the caller just decrypted — the CAS baseline for in-place rotation. */
  ciphertext: string;
  db: LobeChatDatabase;
  /** Revision-pinned fingerprint; rotation rewrites the ciphertext AT this fingerprint. */
  fingerprint: string;
  keyVaults: PlatformProviderKeyVaults;
  providerKey: string;
  /** platform_ai_providers.id (revision resourceId), not the providerKey. */
  providerRowId: string;
  secrets: AiCatalogSecretManager;
}

/**
 * Ensure a shared platform OAuth credential (chatgpt/supergrok) is fresh before
 * execution. No-op for providers without a rotating refresh grant or vaults without a
 * token pair. Refreshes proactively near expiry, serialized across instances by a
 * `platform_jobs` lease, and persists the rotated pair by CAS-rewriting the secret
 * version ciphertext at the revision's stable fingerprint. Returns the vault to use for
 * this execution.
 */
export const refreshSharedOAuthVault = async (
  params: RefreshSharedOAuthVaultParams,
): Promise<PlatformProviderKeyVaults> => {
  const card = DEFAULT_MODEL_PROVIDER_LIST.find((provider) => provider.id === params.providerKey);
  const config = card?.settings?.oauthDeviceFlow;
  if (!config?.refreshTokenGrant) return params.keyVaults;

  const tokens = toOAuthVault(params.keyVaults);
  if (!tokens.oauthAccessToken || !tokens.oauthRefreshToken) return params.keyVaults;
  if (!isOAuthTokenExpiring(tokens)) return params.keyVaults;

  const repository = new PlatformAiCatalogRepository(params.db);
  // The CAS baseline follows every read: after an invalid_grant self-heal re-read, a
  // subsequent persist must expect the ciphertext of the version it actually consumed.
  let lastCiphertext = params.ciphertext;
  let latestFullVault = params.keyVaults;
  // Once a CAS miss reveals a DIFFERENT refresh token in the store, someone else rotated
  // the grant — never CAS again in this flow (we would clobber their newer pair); the
  // refresh policy's fallback re-reads and adopts it instead.
  let foreignRotationDetected = false;

  const readVault = async (): Promise<OAuthTokenKeyVaults> => {
    const version = await repository.getProviderSecretVersion(
      params.providerRowId,
      params.fingerprint,
    );
    if (!version) return {};
    lastCiphertext = version.ciphertext;
    latestFullVault = await params.secrets.decrypt(version.ciphertext);
    return toOAuthVault(latestFullVault);
  };

  const store: OAuthTokenStore = {
    persist: async (next) => {
      // A CAS miss is NOT always a competing rotation: the KEK rewrap worker rewrites
      // the SAME plaintext under a new ciphertext. Losing to it must not strand a
      // rotated pair whose predecessor refresh token is already consumed at the
      // provider — that would kill the shared grant platform-wide. Re-baseline and
      // retry while the durable refresh token is unchanged; only a genuine foreign
      // rotation escapes to the policy fallback.
      for (let attempt = 0; ; attempt += 1) {
        if (foreignRotationDetected) throw new Error('SHARED_OAUTH_ROTATION_CAS_MISS');
        const previousRefreshToken = asString(latestFullVault.oauthRefreshToken);
        const merged = mergeTokens(latestFullVault, next);
        const sealed = await params.secrets.encryptVaultForRotation(merged);
        const updated = await repository.casProviderSecretCiphertext({
          ciphertext: sealed.ciphertext,
          expectedCiphertext: lastCiphertext,
          fingerprint: params.fingerprint,
          keyId: sealed.keyId,
          providerId: params.providerRowId,
        });
        if (updated) {
          lastCiphertext = sealed.ciphertext;
          latestFullVault = merged;
          return;
        }
        if (attempt >= 2) throw new Error('SHARED_OAUTH_ROTATION_CAS_MISS');
        const reread = await readVault();
        if (!reread.oauthRefreshToken) throw new Error('SHARED_OAUTH_ROTATION_CAS_MISS');
        if (reread.oauthRefreshToken !== previousRefreshToken) {
          foreignRotationDetected = true;
          throw new Error('SHARED_OAUTH_ROTATION_CAS_MISS');
        }
      }
    },
    read: readVault,
  };

  const owner = randomUUID();
  const withRefreshLock = async (
    run: (lockedKeyVaults?: OAuthTokenKeyVaults) => Promise<OAuthTokenKeyVaults>,
  ): Promise<OAuthTokenKeyVaults> => {
    const claimed = await claimRefreshLease(params.db, params.providerKey, owner);
    if (claimed) {
      try {
        /**
         * The pre-lock snapshot is NOT safe to refresh with. Acquiring the lease can happen
         * long after this request decrypted the vault — including immediately after another
         * instance rotated the pair and released. Refreshing with that consumed rotating
         * token is token REUSE, which providers answer by revoking the entire grant family,
         * killing the shared credential for every user at once. So re-read durable state
         * first, under the lease.
         */
        const stored = await store.read();
        if (stored.oauthAccessToken && stored.oauthRefreshToken && !isOAuthTokenExpiring(stored)) {
          // Someone else already did the work while we waited — no token call at all.
          log('%s was rotated by another holder while waiting; adopting it', params.providerKey);
          return stored;
        }
        // Still expiring: refresh with what durable state actually holds now. Only when the
        // store has no usable pair (missing secret version) do we fall back to the snapshot.
        return await run(stored.oauthAccessToken && stored.oauthRefreshToken ? stored : undefined);
      } finally {
        // Release is best-effort — lease expiry is the crash backstop.
        await releaseRefreshLease(params.db, params.providerKey, owner).catch(() => {});
      }
    }
    log('another instance is refreshing %s; waiting for its rotated pair', params.providerKey);
    for (let poll = 0; poll < WAITER_MAX_POLLS; poll += 1) {
      await delay(WAITER_POLL_INTERVAL_MS);
      const stored = await store.read();
      if (stored.oauthAccessToken && stored.oauthRefreshToken && !isOAuthTokenExpiring(stored)) {
        return stored;
      }
    }
    // Degraded: proceed with whatever is durable. Worst case this one request 401s and
    // the next attempt re-enters the refresh path — never hard-fail every waiter.
    const stored = await store.read();
    return stored.oauthAccessToken ? stored : tokens;
  };

  const refreshed = await ensureFreshOAuthTokenWithStore({
    config,
    flightKey: `platform:${params.providerKey}`,
    keyVaults: tokens,
    onInvalidGrant: throwSharedGrantExpired,
    providerId: params.providerKey,
    store,
    withRefreshLock,
  });

  return mergeTokens(latestFullVault, refreshed);
};

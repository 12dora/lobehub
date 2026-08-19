import { randomUUID } from 'node:crypto';

import { AgentRuntimeError } from '@lobechat/model-runtime';
import { AgentRuntimeErrorType } from '@lobechat/types';
import debug from 'debug';
import { and, eq, sql } from 'drizzle-orm';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import { platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { PlatformBrowserProfileService } from '@/server/enterprise/services/browserProfile';
import {
  ensureFreshOAuthTokenWithStore,
  type OAuthTokenKeyVaults,
  type OAuthTokenStore,
  shouldRefreshOAuthToken,
} from '@/server/services/oauthDeviceFlow/refresh';

import type { AiCatalogSecretManager, PlatformProviderKeyVaults } from './secretManager';
import { asPlatformVaultString } from './shared';
import {
  clearSharedOAuthReauthMarker,
  markSharedOAuthGrantInvalid,
} from './sharedOAuthReauthMarker';

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

const toOAuthVault = (vault: PlatformProviderKeyVaults): OAuthTokenKeyVaults => ({
  oauthAccessToken: asPlatformVaultString(vault.oauthAccessToken),
  oauthAccountEmail: asPlatformVaultString(vault.oauthAccountEmail),
  oauthAccountId: asPlatformVaultString(vault.oauthAccountId),
  /**
   * The stable device the connection was made with. Carried for the same reason as the kind
   * below: the refresh PRESENTS it (ChatGPT Web sends it as `oai-did`), and the re-read under
   * the cross-instance lease is the snapshot the refresh actually runs on — dropping it here
   * would make every shared renewal look like a new device even though connect named one.
   */
  oauthDeviceId: asPlatformVaultString(vault.oauthDeviceId),
  oauthLastRefreshAt: asPlatformVaultString(vault.oauthLastRefreshAt),
  oauthLastRefreshErrorAt: asPlatformVaultString(vault.oauthLastRefreshErrorAt),
  oauthRefreshToken: asPlatformVaultString(vault.oauthRefreshToken),
  /**
   * Carried through because the refresh path DISPATCHES on it (ChatGPT Web renews either
   * with an OAuth refresh token or with the web session cookie). Dropping it here would
   * silently fall back to identifying the credential by shape — including on the re-read
   * that happens under the cross-instance lease, which is the call that actually runs.
   */
  oauthRenewalKind: asPlatformVaultString(vault.oauthRenewalKind),
  oauthTokenExpiresAt: asPlatformVaultString(vault.oauthTokenExpiresAt),
});

/**
 * Overlay refreshed token leaves; non-OAuth leaves and unknown keys are preserved.
 *
 * The refresh-lifecycle stamps are the only leaves that must also be REMOVABLE: a
 * successful refresh clears `oauthLastRefreshErrorAt` by passing `undefined`, and an
 * additive-only overlay would leave the stale error stamp backing off every future
 * attempt for as long as the vault lives.
 *
 * `clearReauthMarker` belongs to the PERSIST path alone. Clearing on every merge would let the
 * lock path — which can simply adopt another holder's stored tokens without rotating anything —
 * hand back a vault that looks healthy while the durable one is still marked, and the admin
 * status read (which returns this vault) would cache that answer. Only the write that actually
 * rotated the credential has proof the grant recovered.
 */
const mergeTokens = (
  base: PlatformProviderKeyVaults,
  tokens: OAuthTokenKeyVaults,
  options?: { clearReauthMarker?: boolean },
): PlatformProviderKeyVaults => {
  const merged: PlatformProviderKeyVaults = {
    ...base,
    ...(tokens.oauthAccessToken ? { oauthAccessToken: tokens.oauthAccessToken } : {}),
    ...(tokens.oauthAccountEmail ? { oauthAccountEmail: tokens.oauthAccountEmail } : {}),
    ...(tokens.oauthAccountId ? { oauthAccountId: tokens.oauthAccountId } : {}),
    ...(tokens.oauthRefreshToken ? { oauthRefreshToken: tokens.oauthRefreshToken } : {}),
    // The platform vault only stores string leaves.
    ...(tokens.oauthTokenExpiresAt === undefined
      ? {}
      : { oauthTokenExpiresAt: String(tokens.oauthTokenExpiresAt) }),
  };
  for (const leaf of ['oauthLastRefreshAt', 'oauthLastRefreshErrorAt'] as const) {
    if (!(leaf in tokens)) continue;
    const value = tokens[leaf];
    if (value === undefined) delete merged[leaf];
    else merged[leaf] = String(value);
  }
  if (options?.clearReauthMarker && tokens.oauthAccessToken) clearSharedOAuthReauthMarker(merged);
  return merged;
};

/** Matches the payload thrown for a dead shared grant (AgentRuntimeError.createError shape). */
export const isOAuthAuthorizationExpiredError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { errorType?: unknown }).errorType === AgentRuntimeErrorType.OAuthAuthorizationExpired;

/**
 * Persist failed after the token endpoint may already have consumed a rotating
 * refresh token. Callers must not fall back to the pre-refresh vault snapshot —
 * durable storage may still hold the consumed token, and the next expiry would
 * kill the shared account with no failed operation to explain it.
 *
 * The refresh helper wraps store failures as a generic `InvalidProviderAPIKey`
 * object (not an Error), so this class is thrown at the shared-vault boundary
 * after a rotation persist actually failed — never by matching a message.
 */
export class SharedOAuthRefreshPersistError extends Error {
  constructor(cause?: unknown) {
    super(
      'Rotated shared OAuth tokens could not be persisted after the token endpoint consumed the refresh token',
    );
    this.name = 'SharedOAuthRefreshPersistError';
    if (cause !== undefined) this.cause = cause;
  }
}

export const isSharedOAuthRefreshConsumedError = (error: unknown): boolean =>
  error instanceof SharedOAuthRefreshPersistError;

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
  /**
   * Renew even though the access token is still valid — the keepalive sweep, which has
   * already established that this credential is past its 3-day forced-renewal cadence.
   * The post-failure backoff still applies.
   */
  force?: boolean;
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
  if (!shouldRefreshOAuthToken({ config, force: params.force, keyVaults: tokens })) {
    return params.keyVaults;
  }

  const repository = new PlatformAiCatalogRepository(params.db);
  // The CAS baseline follows every read: after an invalid_grant self-heal re-read, a
  // subsequent persist must expect the ciphertext of the version it actually consumed.
  let lastCiphertext = params.ciphertext;
  let latestFullVault = params.keyVaults;
  // Once a CAS miss reveals a DIFFERENT refresh token in the store, someone else rotated
  // the grant — never CAS again in this flow (we would clobber their newer pair); the
  // refresh policy's fallback re-reads and adopts it instead.
  let foreignRotationDetected = false;
  // `ensureFreshOAuthTokenWithStore` swallows the persist error and throws a generic
  // object. Track whether *this* persist was a post-exchange rotation so we can
  // rethrow a real type after the helper returns.
  let persistFailedAfterRotation = false;

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
      try {
        // A CAS miss is NOT always a competing rotation: the KEK rewrap worker rewrites
        // the SAME plaintext under a new ciphertext. Losing to it must not strand a
        // rotated pair whose predecessor refresh token is already consumed at the
        // provider — that would kill the shared grant platform-wide. Re-baseline and
        // retry while the durable refresh token is unchanged; only a genuine foreign
        // rotation escapes to the policy fallback.
        for (let attempt = 0; ; attempt += 1) {
          if (foreignRotationDetected) throw new Error('SHARED_OAUTH_ROTATION_CAS_MISS');
          const previousRefreshToken = asPlatformVaultString(latestFullVault.oauthRefreshToken);
          // The only write that PROVES the grant recovered, so the only one allowed to drop the
          // reauth marker (a lifecycle-stamp-only persist carries no access token and keeps it).
          const merged = mergeTokens(latestFullVault, next, { clearReauthMarker: true });
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
            persistFailedAfterRotation = false;
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
      } catch (error) {
        // Lifecycle-stamp-only writes have no access token — those are not a consumed rotation.
        if (next.oauthAccessToken && next.oauthRefreshToken) persistFailedAfterRotation = true;
        throw error;
      }
    },
    read: readVault,
  };

  /**
   * "Someone else already did the work" is judged by the UNFORCED policy: a keepalive
   * that another holder just completed leaves durable state with a fresh
   * `oauthLastRefreshAt`, which satisfies this flow too. Re-asking with `force` would
   * make every holder rotate in turn.
   */
  const isSatisfiedBy = (stored: OAuthTokenKeyVaults): boolean =>
    Boolean(stored.oauthAccessToken) &&
    Boolean(stored.oauthRefreshToken) &&
    !shouldRefreshOAuthToken({ config, keyVaults: stored });

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
        if (isSatisfiedBy(stored)) {
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
      if (isSatisfiedBy(stored)) return stored;
    }
    // Degraded: proceed with whatever is durable. Worst case this one request 401s and
    // the next attempt re-enters the refresh path — never hard-fail every waiter.
    const stored = await store.read();
    return stored.oauthAccessToken ? stored : tokens;
  };

  let refreshed: OAuthTokenKeyVaults;
  try {
    const browserProfile =
      params.providerKey === 'chatgptweb'
        ? await new PlatformBrowserProfileService(params.db).getOrFallback()
        : undefined;
    refreshed = await ensureFreshOAuthTokenWithStore({
      browserProfile,
      ...(params.providerKey === 'chatgptweb'
        ? {
            browserSessionAccountId: `platform:${params.providerKey}`,
          }
        : {}),
      config,
      flightKey: `platform:${params.providerKey}`,
      force: params.force,
      keyVaults: tokens,
      onInvalidGrant: throwSharedGrantExpired,
      providerId: params.providerKey,
      store,
      withRefreshLock,
    });
  } catch (error) {
    if (persistFailedAfterRotation) throw new SharedOAuthRefreshPersistError(error);
    /**
     * A DEAD grant is the one failure an operator has to act on, and until now nothing wrote
     * it down: the admin card re-ran this refresh, saw the same throw, and reported the
     * connection as healthy the moment the stored access token was not yet near expiry.
     * Stamped here (not inside `throwSharedGrantExpired`, which is a synchronous `never`) so
     * every caller — runtime execution, keepalive sweep, admin status read — records it once.
     *
     * Best-effort by construction: `markSharedOAuthGrantInvalid` never throws, and the
     * original error is re-thrown unchanged. Transient failures fall straight through.
     */
    if (isOAuthAuthorizationExpiredError(error)) {
      await markSharedOAuthGrantInvalid({
        // The freshest baseline this flow has seen — `readVault` moves both under the lease.
        ciphertext: lastCiphertext,
        db: params.db,
        fingerprint: params.fingerprint,
        keyVaults: latestFullVault,
        providerRowId: params.providerRowId,
        reason: 'invalidGrant',
        secrets: params.secrets,
      });
    }
    throw error;
  }

  /**
   * No `clearReauthMarker` here: this merge only projects the vault this execution runs on. If a
   * rotation was persisted, `latestFullVault` IS the cleared write; if the lock path merely
   * adopted another holder's tokens, durable state may still carry a marker written after that
   * holder rotated — and this response must not contradict it.
   */
  return mergeTokens(latestFullVault, refreshed);
};

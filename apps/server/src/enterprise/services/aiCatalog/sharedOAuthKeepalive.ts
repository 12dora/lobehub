import { randomUUID } from 'node:crypto';

import debug from 'debug';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import { platformAiProviders, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import {
  type OAuthTokenKeyVaults,
  shouldRefreshOAuthToken,
} from '@/server/services/oauthDeviceFlow/refresh';
import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import type { AiCatalogSecretManager } from './secretManager';
import { asPlatformVaultString } from './shared';
import { isOAuthAuthorizationExpiredError, refreshSharedOAuthVault } from './sharedOAuthRefresh';

const log = debug('lobe-server:ai-catalog-shared-oauth-keepalive');

/**
 * Fleet-wide cadence gate for the shared-OAuth keepalive sweep. One `platform_jobs` row
 * (this type + {@link KEEPALIVE_SWEEP_KEY}) doubles as the lease AND the "next run due"
 * marker: a finished sweep parks `leaseUntil` an hour into the future, so every replica's
 * timer finds the row unclaimable until then. A crashed sweep instead leaves the shorter
 * claim lease behind, which expires and lets another replica take over.
 */
export const SHARED_OAUTH_KEEPALIVE_JOB_TYPE = 'platform.ai.oauth.keepalive.v1';
const KEEPALIVE_SWEEP_KEY = 'sweep';

/** Crash backstop for one sweep. Generous: each provider may wait on a refresh lease. */
const SWEEP_LEASE_SECONDS = 900;
/** Cadence between sweeps. Well below the 3-day keepalive window, so nothing is missed. */
const SWEEP_INTERVAL_SECONDS = 3600;
/** After a sweep threw, retry sooner than the normal cadence but not on every timer tick. */
const SWEEP_RETRY_SECONDS = 300;

/**
 * Providers renewed per sweep. Each one is a rotating-refresh token call under a
 * cross-instance lease; keeping the batch small bounds how long a tick holds the sweep
 * lease and spreads renewals instead of hammering one provider's token endpoint. There
 * are only a handful of rotating-refresh providers in total, so this is not a backlog
 * risk — an undone provider is simply picked up an hour later, far inside the 3-day window.
 */
export const SHARED_OAUTH_KEEPALIVE_BATCH_SIZE = 3;

/**
 * Device-flow cards whose grant issues a ROTATING refresh token
 * (chatgpt/chatgptweb/supergrok), keyed by provider id.
 *
 * The card, not just the id: the refresh decision is provider-configurable
 * (`refreshSkewMs`, `refreshTokenGrant`) and the sweep evaluates the very same policy
 * every other refresh path does.
 */
const rotatingRefreshProviderConfigs = (): Map<string, OAuthDeviceFlowConfig> => {
  const configs = new Map<string, OAuthDeviceFlowConfig>();
  for (const provider of DEFAULT_MODEL_PROVIDER_LIST) {
    const config = provider.settings?.oauthDeviceFlow;
    if (config?.refreshTokenGrant === true) configs.set(provider.id, config);
  }
  return configs;
};

/**
 * Stable, provider-prose-free identity for a thrown error.
 *
 * Token-endpoint failures are composed from the provider's response body (`error`,
 * `error_description`), which can echo request material back at us. None of that may reach
 * the logs, so only the error CLASS (or the runtime's own error type) is ever recorded.
 */
const errorClassOf = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return typeof error;
  const errorType = (error as { errorType?: unknown }).errorType;
  if (typeof errorType === 'string' && errorType.length > 0) return errorType;
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && name.length > 0) return name;
  return error.constructor?.name ?? 'Object';
};

const claimSweepLease = async (db: LobeChatDatabase, owner: string): Promise<boolean> => {
  await db
    .insert(platformJobs)
    .values({ idempotencyKey: KEEPALIVE_SWEEP_KEY, type: SHARED_OAUTH_KEEPALIVE_JOB_TYPE })
    .onConflictDoNothing();
  const rows = await db
    .update(platformJobs)
    .set({
      attempt: sql`${platformJobs.attempt} + 1`,
      heartbeatAt: sql`clock_timestamp()`,
      leaseOwner: owner,
      // DB clock, not process clock — replicas' clocks are not trusted to agree.
      leaseUntil: sql`clock_timestamp() + make_interval(secs => ${SWEEP_LEASE_SECONDS})`,
      startedAt: sql`clock_timestamp()`,
      status: 'running',
    })
    .where(
      and(
        eq(platformJobs.type, SHARED_OAUTH_KEEPALIVE_JOB_TYPE),
        eq(platformJobs.idempotencyKey, KEEPALIVE_SWEEP_KEY),
        sql`(${platformJobs.leaseUntil} IS NULL OR ${platformJobs.leaseUntil} < clock_timestamp())`,
      ),
    )
    .returning({ id: platformJobs.id });
  return rows.length > 0;
};

/**
 * Park the row until the next cadence window. `leaseOwner` is cleared but `leaseUntil` is
 * NOT — it is what stops every other replica from re-sweeping minutes later.
 *
 * Returns whether the park landed. A park that fails is not fatal (the sweep itself
 * already ran) but it is not nothing either: the row then falls back to the 15-minute
 * crash lease, so the fleet re-sweeps four times an hour instead of once. The caller
 * surfaces it rather than swallowing it.
 */
const parkSweepLease = async (
  db: LobeChatDatabase,
  owner: string,
  nextRunInSeconds: number,
  failed: boolean,
): Promise<boolean> => {
  try {
    await db
      .update(platformJobs)
      .set({
        finishedAt: new Date(),
        leaseOwner: null,
        leaseUntil: sql`clock_timestamp() + make_interval(secs => ${nextRunInSeconds})`,
        status: failed ? 'failed' : 'succeeded',
      })
      .where(
        and(
          eq(platformJobs.type, SHARED_OAUTH_KEEPALIVE_JOB_TYPE),
          eq(platformJobs.idempotencyKey, KEEPALIVE_SWEEP_KEY),
          eq(platformJobs.leaseOwner, owner),
        ),
      );
    return true;
  } catch (error) {
    console.error(
      `[ai-catalog-shared-oauth-keepalive] could not park the sweep lease (errorClass=${errorClassOf(error)}); ` +
        `the cadence falls back to the ${SWEEP_LEASE_SECONDS}s crash lease, so the next sweep may start early`,
    );
    return false;
  }
};

export interface SharedOAuthKeepaliveSweepParams {
  batchSize?: number;
  db: LobeChatDatabase;
  now?: number;
  secrets: AiCatalogSecretManager;
}

export interface SharedOAuthKeepaliveSweepResult {
  /** false when another replica holds the lease, or the cadence window has not reopened. */
  claimed: boolean;
  /** Providers whose keepalive refresh threw (already backoff-stamped by the refresh path). */
  failed: number;
  /**
   * Whether the cadence park landed. `false` on a claimed sweep means the hourly window was
   * not written and the fleet falls back to the shorter crash lease.
   */
  parked: boolean;
  /** Providers that were due and got a forced renewal attempt. */
  refreshed: number;
  /** Candidate rows examined. */
  scanned: number;
}

/**
 * Force-renew shared (platform) rotating-refresh OAuth credentials whose refresh token has
 * not been presented for three days.
 *
 * Why this exists at all: those providers invalidate a refresh token that goes unused. A
 * shared account nobody happened to chat with over a long weekend would otherwise come
 * back dead for EVERY member of the instance, and only an administrator can reconnect it.
 * Personal credentials renew lazily on their owner's next request (see
 * `oauthDeviceFlow/refresh.ts`), which is an acceptable trade because the blast radius is
 * one user who can fix it themselves.
 *
 * Which credentials are due is decided by the shared `shouldRefreshOAuthToken` policy, not
 * by a second copy of the rules here — so the sweep also pre-warms a shared token inside
 * the provider's proactive window, and an already-expired token still gets its retry even
 * while a recent failure is backing the credential off.
 *
 * Everything race-sensitive is delegated: {@link refreshSharedOAuthVault} takes the
 * per-provider cross-instance lease and CAS-persists the rotated pair, so a sweep racing
 * a live chat request cannot double-spend the rotating token. The sweep only decides WHO
 * is due, and stops after {@link SHARED_OAUTH_KEEPALIVE_BATCH_SIZE} providers.
 */
export const runSharedOAuthKeepaliveSweep = async (
  params: SharedOAuthKeepaliveSweepParams,
): Promise<SharedOAuthKeepaliveSweepResult> => {
  const { db, secrets } = params;
  const now = params.now ?? Date.now();
  const batchSize = Math.max(1, params.batchSize ?? SHARED_OAUTH_KEEPALIVE_BATCH_SIZE);
  const providerConfigs = rotatingRefreshProviderConfigs();
  const providerKeys = [...providerConfigs.keys()];
  if (providerKeys.length === 0) {
    return { claimed: false, failed: 0, parked: false, refreshed: 0, scanned: 0 };
  }

  const owner = randomUUID();
  if (!(await claimSweepLease(db, owner))) {
    return { claimed: false, failed: 0, parked: false, refreshed: 0, scanned: 0 };
  }

  let failed = 0;
  let refreshed = 0;
  let scanned = 0;
  try {
    const candidates = await db
      .select({
        ciphertext: platformAiProviders.encryptedKeyVaults,
        fingerprint: platformAiProviders.secretFingerprint,
        id: platformAiProviders.id,
        providerKey: platformAiProviders.providerKey,
      })
      .from(platformAiProviders)
      .where(
        and(
          eq(platformAiProviders.enabled, true),
          inArray(platformAiProviders.providerKey, providerKeys),
          isNotNull(platformAiProviders.encryptedKeyVaults),
          isNotNull(platformAiProviders.secretFingerprint),
        ),
      )
      // Stable order so a batch-size-limited sweep does not starve the same provider twice.
      .orderBy(asc(platformAiProviders.providerKey));

    for (const candidate of candidates) {
      if (refreshed >= batchSize) break;
      const ciphertext = candidate.ciphertext;
      const fingerprint = candidate.fingerprint;
      if (!ciphertext || !fingerprint) continue;
      scanned += 1;

      let keyVaults;
      try {
        keyVaults = await secrets.decrypt(ciphertext);
      } catch (error) {
        // An unreadable vault is a key-management problem, not a keepalive problem, and
        // it is already surfaced by the admin credential paths. Never let it abort the
        // sweep for the other providers.
        failed += 1;
        log('cannot read the shared vault for %s: %O', candidate.providerKey, error);
        continue;
      }

      const tokens: OAuthTokenKeyVaults = {
        oauthAccessToken: asPlatformVaultString(keyVaults.oauthAccessToken),
        oauthLastRefreshAt: asPlatformVaultString(keyVaults.oauthLastRefreshAt),
        oauthLastRefreshErrorAt: asPlatformVaultString(keyVaults.oauthLastRefreshErrorAt),
        oauthRefreshToken: asPlatformVaultString(keyVaults.oauthRefreshToken),
        oauthTokenExpiresAt: asPlatformVaultString(keyVaults.oauthTokenExpiresAt),
      };
      // A pasted access token has no grant to keep alive.
      if (!tokens.oauthAccessToken || !tokens.oauthRefreshToken) continue;
      /**
       * ONE policy for every refresh path. The sweep must not re-derive its own gate from
       * the individual predicates: doing so dropped the expired-token exception, so a
       * shared credential that was BOTH past expiry and inside its post-failure backoff got
       * skipped — exactly the case where there is no working token left to protect and the
       * retry has to go through.
       */
      if (
        !shouldRefreshOAuthToken({
          config: providerConfigs.get(candidate.providerKey),
          keyVaults: tokens,
          now,
        })
      ) {
        continue;
      }

      refreshed += 1;
      try {
        await refreshSharedOAuthVault({
          ciphertext,
          db,
          fingerprint,
          force: true,
          keyVaults,
          providerKey: candidate.providerKey,
          providerRowId: candidate.id,
          secrets,
        });
        log('keepalive renewed the shared %s connection', candidate.providerKey);
      } catch (error) {
        failed += 1;
        /**
         * A dead grant needs an administrator, and there is no admin in a background
         * sweep — log it and move on. The next admin page load reports it as expired.
         *
         * Provider id + classification ONLY: the error itself is composed from the token
         * endpoint's response body, which is provider-controlled prose that can echo
         * request material (credentials included) straight into the log stream.
         */
        console.error(
          `[ai-catalog-shared-oauth-keepalive] renewal failed provider=${candidate.providerKey} ` +
            `category=${isOAuthAuthorizationExpiredError(error) ? 'authorization_expired' : 'transient'} ` +
            `errorClass=${errorClassOf(error)}` +
            (isOAuthAuthorizationExpiredError(error)
              ? '; the shared connection is dead and an administrator must reconnect it'
              : ''),
        );
      }
    }
  } catch (error) {
    await parkSweepLease(db, owner, SWEEP_RETRY_SECONDS, true);
    throw error;
  }

  const parked = await parkSweepLease(db, owner, SWEEP_INTERVAL_SECONDS, false);
  return { claimed: true, failed, parked, refreshed, scanned };
};

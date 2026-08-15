import { AgentRuntimeError } from '@lobechat/model-runtime';
import { AgentRuntimeErrorType } from '@lobechat/types';
import debug from 'debug';

import { AiProviderModel } from '@/database/models/aiProvider';
import { type LobeChatDatabase } from '@/database/type';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { type OAuthDeviceFlowConfig } from '@/types/aiProvider';

import { OAuthInvalidGrantError, parseJwtExpiry, parseJwtIssuedAt } from './index';
import { getOAuthService } from './providers/githubCopilot';

const log = debug('lobe-server:oauth-token-refresh');

/**
 * Refresh the access token this long before it actually expires, so a request
 * dispatched right at the boundary doesn't hit a mid-flight 401.
 *
 * Per-provider override: `settings.oauthDeviceFlow.refreshSkewMs` (ChatGPT Web uses 24 h,
 * because OpenAI invalidates a refresh token that goes unused).
 */
const DEFAULT_REFRESH_SKEW_MS = 120_000;

/**
 * How long a failed refresh suppresses the next PROACTIVE attempt.
 *
 * A token endpoint that is down, rate-limiting, or 5xx-ing answers the retry the same
 * way; without this, every request in the (now 24 h wide) refresh window fires another
 * call. Deliberately does NOT apply once the access token is actually past expiry: at
 * that point there is no working credential to protect and refusing to retry would take
 * the connection down for the whole window with no fallback.
 */
const REFRESH_ERROR_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Force a refresh this long after the last one even when the access token is still valid.
 *
 * Rotating-refresh providers expire a refresh token that is never presented, so a
 * credential used rarely (or a shared account nobody touched this week) silently loses
 * the ability to renew. Renewing on a fixed cadence keeps the grant family alive.
 */
const REFRESH_KEEPALIVE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Deadline for ONE token-endpoint call. Deliberately below the shared refresh lease
 * (`LEASE_SECONDS = 30` in `enterprise/services/aiCatalog/sharedOAuthRefresh.ts`) with room
 * for the persist that follows: a call that outlives the lease lets a second instance
 * present the same rotating refresh token, and providers answer that reuse by revoking the
 * whole grant family — killing a shared credential for every user at once.
 */
const REFRESH_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Fallback access-token lifetime when the provider returns neither
 * `expires_in` nor a parseable JWT `exp` claim.
 */
const DEFAULT_TOKEN_TTL_MS = 3600 * 1000;

export interface OAuthTokenKeyVaults {
  oauthAccessToken?: string;
  oauthAccountId?: string;
  /** Keepalive anchor: epoch ms of the last successful refresh (string in platform vaults). */
  oauthLastRefreshAt?: number | string;
  /** Backoff anchor: epoch ms of the last failed refresh (cleared on the next success). */
  oauthLastRefreshErrorAt?: number | string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: number | string;
}

/**
 * Persistence seam for the refresh policy: the user path stores per-user
 * `ai_providers` keyVaults, the platform path CAS-rewrites the shared catalog
 * secret. `read` must always return the CURRENT durable state (it is the
 * self-heal source after invalid_grant and persist races).
 */
export interface OAuthTokenStore {
  persist: (next: OAuthTokenKeyVaults) => Promise<void>;
  read: () => Promise<OAuthTokenKeyVaults>;
}

interface EnsureFreshOAuthTokenParams {
  config: OAuthDeviceFlowConfig;
  db: LobeChatDatabase;
  keyVaults: OAuthTokenKeyVaults;
  providerId: string;
  userId: string;
  workspaceId?: string;
}

export interface EnsureFreshOAuthTokenWithStoreParams {
  config: OAuthDeviceFlowConfig;
  /** In-process single-flight key; concurrent callers with the same key share one refresh. */
  flightKey: string;
  /**
   * Refresh even though the access token is still comfortably valid — the keepalive
   * sweep's entry point. The post-failure backoff still applies.
   */
  force?: boolean;
  keyVaults: OAuthTokenKeyVaults;
  /** Override the terminal invalid_grant error (e.g. platform credentials need an admin-facing message). */
  onInvalidGrant?: (providerId: string) => never;
  providerId: string;
  store: OAuthTokenStore;
  /**
   * Optional cross-instance mutual exclusion wrapped around the token-endpoint call.
   * With rotating refresh tokens, two instances refreshing with the same token trip the
   * provider's reuse detection and can revoke the whole grant family — a shared
   * (platform) credential must serialize refreshes across instances, not just in-process.
   * The wrapper either runs `run()` (lock held) or resolves with the rotated pair some
   * other holder persisted.
   *
   * `run` accepts an override pair so a holder that re-read durable state AFTER acquiring
   * the lock refreshes with what it just read. Waiting for a lock is exactly the window in
   * which the pre-lock snapshot goes stale: calling the token endpoint with a refresh token
   * a previous holder already consumed is the reuse that revokes the grant family.
   */
  withRefreshLock?: (
    run: (lockedKeyVaults?: OAuthTokenKeyVaults) => Promise<OAuthTokenKeyVaults>,
  ) => Promise<OAuthTokenKeyVaults>;
}

/**
 * In-process single-flight registry: concurrent requests for the same
 * user/provider collapse onto one refresh HTTP call. Critical for rotating
 * refresh tokens (single use) — two parallel refreshes with the same token
 * would invalidate each other.
 */
const inflight = new Map<string, Promise<OAuthTokenKeyVaults>>();

/** Vault leaves are numbers in user configs and strings in the platform vault. */
const toTimestamp = (value: number | string | undefined): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Provider-configurable proactive-refresh window; 2 minutes unless the card widens it. */
export const resolveRefreshSkewMs = (config?: Pick<OAuthDeviceFlowConfig, 'refreshSkewMs'>) =>
  config?.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;

/**
 * Stored expiry is best-effort (the provider may not return `expires_in`), so the JWT
 * `exp` claim is a second opinion and the EARLIER of the two wins. Undefined means
 * "unknown", which every caller treats as the conservative answer.
 */
const resolveExpiresAt = (keyVaults: OAuthTokenKeyVaults): number | undefined => {
  const storedExpiresAt = toTimestamp(keyVaults.oauthTokenExpiresAt);
  const jwtExpiresAt = parseJwtExpiry(keyVaults.oauthAccessToken);
  if (storedExpiresAt !== undefined && jwtExpiresAt !== undefined) {
    return Math.min(storedExpiresAt, jwtExpiresAt);
  }
  return storedExpiresAt ?? jwtExpiresAt;
};

/** Inside the proactive-refresh window (or expiry unknown, which refreshes conservatively). */
export const isOAuthTokenExpiring = (
  keyVaults: OAuthTokenKeyVaults,
  config?: Pick<OAuthDeviceFlowConfig, 'refreshSkewMs'>,
  now: number = Date.now(),
): boolean => {
  const expiresAt = resolveExpiresAt(keyVaults);
  if (expiresAt === undefined) return true;
  return expiresAt - now <= resolveRefreshSkewMs(config);
};

/** Past its ACTUAL expiry — i.e. there is no working credential left to protect. */
const isAccessTokenExpired = (keyVaults: OAuthTokenKeyVaults, now: number): boolean => {
  const expiresAt = resolveExpiresAt(keyVaults);
  return expiresAt === undefined || expiresAt <= now;
};

/**
 * When the grant was last proven alive: the recorded refresh, else the access token's
 * `iat` (a token minted at connect time dates the grant just as well).
 */
export const resolveOAuthKeepaliveAnchor = (keyVaults: OAuthTokenKeyVaults): number | undefined =>
  toTimestamp(keyVaults.oauthLastRefreshAt) ?? parseJwtIssuedAt(keyVaults.oauthAccessToken);

/**
 * A refresh token that is never presented can be dropped by the provider, so renew on a
 * fixed cadence even while the access token is still good.
 *
 * No anchor at all counts as due: every success stamps `oauthLastRefreshAt`, so a
 * credential can be in that state at most once, whereas "never due" would leave every
 * connection made before this bookkeeping existed without keepalive forever.
 */
const isOAuthKeepaliveDue = (keyVaults: OAuthTokenKeyVaults, now: number = Date.now()): boolean => {
  const anchor = resolveOAuthKeepaliveAnchor(keyVaults);
  if (anchor === undefined) return true;
  return now - anchor >= REFRESH_KEEPALIVE_MS;
};

/** Within the post-failure quiet period. */
const isOAuthRefreshBackedOff = (
  keyVaults: OAuthTokenKeyVaults,
  now: number = Date.now(),
): boolean => {
  const lastErrorAt = toTimestamp(keyVaults.oauthLastRefreshErrorAt);
  return lastErrorAt !== undefined && now - lastErrorAt < REFRESH_ERROR_BACKOFF_MS;
};

export interface OAuthRefreshPolicyParams {
  config?: Pick<OAuthDeviceFlowConfig, 'refreshSkewMs' | 'refreshTokenGrant'>;
  /**
   * Skip the expiry/keepalive gates — the background keepalive sweep has already decided
   * this credential is due. Backoff still applies: forcing through a provider outage is
   * exactly the hammering the backoff exists to stop.
   */
  force?: boolean;
  keyVaults: OAuthTokenKeyVaults;
  now?: number;
}

/**
 * The single refresh decision: proactive expiry (provider-configurable skew), forced
 * keepalive, and the post-failure backoff, in one place so the user path, the platform
 * path and the keepalive sweep cannot drift apart.
 */
export const shouldRefreshOAuthToken = ({
  config,
  force,
  keyVaults,
  now = Date.now(),
}: OAuthRefreshPolicyParams): boolean => {
  // Backoff protects a credential that still works. Once the access token is genuinely
  // expired there is nothing left to fall back on, so the retry must go through.
  if (!isAccessTokenExpired(keyVaults, now) && isOAuthRefreshBackedOff(keyVaults, now)) {
    return false;
  }
  if (Boolean(force) || isOAuthTokenExpiring(keyVaults, config, now)) return true;
  // Keepalive is only meaningful where the provider can drop an unused refresh token,
  // i.e. the rotating-refresh grants. A provider handing out a stable, storable token
  // (GitHub Copilot) gains nothing from renewing early and should keep the old behaviour.
  return config?.refreshTokenGrant === true && isOAuthKeepaliveDue(keyVaults, now);
};

const readStoredKeyVaults = async (
  db: LobeChatDatabase,
  userId: string,
  providerId: string,
  workspaceId?: string,
): Promise<OAuthTokenKeyVaults> => {
  const aiProviderModel = new AiProviderModel(db, userId, workspaceId);
  const providerConfig = await aiProviderModel.getAiProviderById(
    providerId,
    KeyVaultsGateKeeper.getUserKeyVaults,
  );

  return (providerConfig?.keyVaults || {}) as OAuthTokenKeyVaults;
};

/**
 * PARTIAL BY CONSTRUCTION: only the leaves PRESENT on `keyVaults` are written.
 *
 * `updateConfig` merges `{...existing, ...patch}` before re-encrypting, so an ABSENT leaf
 * keeps its stored value while an explicitly `undefined` one is dropped by
 * `JSON.stringify` — i.e. deleted. Both halves are load-bearing:
 * - a successful rotation passes all six leaves, which is how `oauthLastRefreshErrorAt`
 *   gets cleared in the same durable write that stamps the new pair;
 * - a failed refresh passes the error stamp ALONE, so it can never merge its captured
 *   (possibly already rotated away) token pair over a concurrent success.
 */
const persistKeyVaults = async (
  db: LobeChatDatabase,
  userId: string,
  providerId: string,
  keyVaults: OAuthTokenKeyVaults,
  workspaceId?: string,
) => {
  const aiProviderModel = new AiProviderModel(db, userId, workspaceId);
  const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();

  const patch: Record<string, string | undefined> = {};
  if ('oauthAccountId' in keyVaults) patch.oauthAccountId = keyVaults.oauthAccountId;
  if ('oauthAccessToken' in keyVaults) patch.oauthAccessToken = keyVaults.oauthAccessToken;
  if ('oauthLastRefreshAt' in keyVaults) {
    patch.oauthLastRefreshAt = asVaultTimestamp(keyVaults.oauthLastRefreshAt);
  }
  if ('oauthLastRefreshErrorAt' in keyVaults) {
    patch.oauthLastRefreshErrorAt = asVaultTimestamp(keyVaults.oauthLastRefreshErrorAt);
  }
  if ('oauthRefreshToken' in keyVaults) patch.oauthRefreshToken = keyVaults.oauthRefreshToken;
  if ('oauthTokenExpiresAt' in keyVaults) {
    patch.oauthTokenExpiresAt = asVaultTimestamp(keyVaults.oauthTokenExpiresAt);
  }

  await aiProviderModel.updateConfig(
    providerId,
    { keyVaults: patch },
    gateKeeper.encrypt,
    KeyVaultsGateKeeper.getUserKeyVaults,
  );
};

/** `UpdateAiProviderConfigSchema` only accepts string leaves; `undefined` deletes. */
const asVaultTimestamp = (value: number | string | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

const throwInvalidGrant = (providerId: string): never => {
  // Deliberately do NOT clear keyVaults here: the stored state is the only
  // evidence for debugging, and the user just needs to re-connect from the
  // provider settings page (which overwrites it).
  log('OAuth authorization expired provider=%s reason=invalid_grant', providerId);
  throw AgentRuntimeError.createError(AgentRuntimeErrorType.OAuthAuthorizationExpired, {
    message:
      'Your connection to this provider has expired. Reconnect it in Provider settings, then try again.',
  });
};

const throwRefreshPersistenceFailure = (providerId: string): never => {
  throw AgentRuntimeError.createError(AgentRuntimeErrorType.InvalidProviderAPIKey, {
    message: `OAuth tokens for provider "${providerId}" could not be saved`,
  });
};

/** Transient persistence retries before treating the rotation as stranded. */
const PERSIST_MAX_ATTEMPTS = 3;
const PERSIST_RETRY_DELAY_MS = 50;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Write rotated tokens durably. Never return a pair that exists only in memory:
 * a consumed refresh token that is not in the DB strands every later request
 * (and every other instance) with an irrecoverable invalid_grant.
 */
const persistRotatedKeyVaults = async (
  params: EnsureFreshOAuthTokenWithStoreParams,
  nextKeyVaults: OAuthTokenKeyVaults,
  /**
   * The refresh token the token-endpoint call actually consumed (differs from
   * params.keyVaults after an invalid_grant self-heal picked up a newer stored token).
   * A stored pair is only "someone else's rotation" when its refresh token differs
   * from THIS one — comparing against the flow's original token can mistake our own
   * just-consumed pair for a fresh one.
   */
  consumedRefreshToken: string,
): Promise<OAuthTokenKeyVaults> => {
  const { flightKey, providerId, store } = params;
  let lastError: unknown;

  for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      await store.persist(nextKeyVaults);
      return nextKeyVaults;
    } catch (error) {
      lastError = error;
      log('persist attempt %d/%d failed for %s', attempt, PERSIST_MAX_ATTEMPTS, flightKey);
      if (attempt < PERSIST_MAX_ATTEMPTS) await delay(PERSIST_RETRY_DELAY_MS * attempt);
    }
  }

  // Another instance may have won a race and written the same (or newer) pair.
  try {
    const stored = await store.read();
    if (
      stored.oauthAccessToken &&
      stored.oauthRefreshToken &&
      stored.oauthRefreshToken !== consumedRefreshToken &&
      !isOAuthTokenExpiring(stored, params.config)
    ) {
      return stored;
    }
    if (
      stored.oauthRefreshToken === nextKeyVaults.oauthRefreshToken &&
      stored.oauthAccessToken === nextKeyVaults.oauthAccessToken
    ) {
      return stored;
    }
  } catch {
    // Fall through to reconnect-required.
  }

  console.error(
    `[oauth-token-refresh] failed to persist rotated tokens for ${providerId}; requiring re-connect:`,
    lastError,
  );
  return throwRefreshPersistenceFailure(providerId);
};

/**
 * Record that a refresh attempt failed, so the next few minutes of requests skip the
 * token endpoint instead of re-running a call that is currently failing for everyone.
 *
 * TRANSIENT failures only. `invalid_grant` is deliberately excluded: it is terminal, and
 * backing it off would make the following requests skip the refresh and hit the provider
 * with an expired token — trading the actionable "reconnect this provider" error for an
 * opaque upstream 401.
 *
 * Best-effort by construction: it must never convert a transient refresh failure into a
 * different (persistence) failure.
 *
 * It must also never TOUCH the token pair. Two rules enforce that:
 * 1. the write carries `oauthLastRefreshErrorAt` and nothing else, so the captured (by now
 *    possibly stale) tokens cannot be merged back over a concurrent rotation — writing an
 *    already-consumed refresh token back into durable state would strand the credential;
 * 2. durable state is re-read first and the stamp is skipped unless it still holds the
 *    exact refresh token that failed. A different token means another writer rotated and
 *    deliberately cleared the stamp, and re-arming it would back off a credential that
 *    currently works.
 */
const stampRefreshFailure = async (
  params: EnsureFreshOAuthTokenWithStoreParams,
  /** The refresh token the failed token-endpoint call actually presented. */
  failedRefreshToken: string,
  now: number,
): Promise<void> => {
  try {
    const stored = await params.store.read();
    if (!stored.oauthRefreshToken || stored.oauthRefreshToken !== failedRefreshToken) {
      log(
        'skipping the refresh backoff stamp for %s: durable state no longer holds the failed refresh token',
        params.flightKey,
      );
      return;
    }
    await params.store.persist({ oauthLastRefreshErrorAt: now });
  } catch (error) {
    log('failed to record refresh backoff for %s: %O', params.flightKey, error);
  }
};

const refreshAndPersist = async (
  params: EnsureFreshOAuthTokenWithStoreParams,
): Promise<OAuthTokenKeyVaults> => {
  const { config, flightKey, keyVaults, providerId, store } = params;
  /**
   * The PROVIDER'S service, never the base one: a provider whose token endpoint needs a
   * different wire (ChatGPT Web: form-encoded with the platform User-Agent, a bounded
   * request, and errors composed here rather than echoed from the response) overrides
   * `refreshAccessToken`, and instantiating the base class made that override dead code on
   * the only path that ever refreshes. Providers without an override get the base service,
   * exactly as before.
   */
  const service = getOAuthService(providerId);
  const usedRefreshToken = keyVaults.oauthRefreshToken!;
  const invalidGrant = params.onInvalidGrant ?? throwInvalidGrant;
  const refreshOptions = { signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS) };
  let consumedRefreshToken = usedRefreshToken;

  /**
   * One token-endpoint call plus the backoff bookkeeping that belongs to it. Only the
   * call is wrapped: the persist phase below is a different failure mode with its own
   * handling, and `invalid_grant` is routed by the caller instead of backed off.
   */
  const callTokenEndpoint = async (refreshToken: string) => {
    try {
      return await service.refreshAccessToken(config, refreshToken, refreshOptions);
    } catch (error) {
      if (!(error instanceof OAuthInvalidGrantError)) {
        // Keyed to the token THIS call presented: after the invalid_grant self-heal the
        // retry runs on the re-read token, and stamping against the original would both
        // measure the wrong credential and risk reviving the rejected pair.
        await stampRefreshFailure(params, refreshToken, Date.now());
      }
      throw error;
    }
  };

  let tokens;
  try {
    tokens = await callTokenEndpoint(usedRefreshToken);
  } catch (error) {
    if (!(error instanceof OAuthInvalidGrantError)) throw error;

    // invalid_grant self-heal: with rotating refresh tokens, "our" token being
    // rejected usually means another server instance already consumed it and
    // persisted a newer pair. Re-read the store before declaring the grant dead.
    log('invalid_grant for %s, re-reading stored credentials', flightKey);
    const stored = await store.read();

    // Same token in the store as the one that was just rejected → truly dead.
    if (!stored.oauthRefreshToken || stored.oauthRefreshToken === usedRefreshToken) {
      invalidGrant(providerId);
    }

    // Another instance rotated: its access token may already be fresh enough.
    if (stored.oauthAccessToken && !isOAuthTokenExpiring(stored, config)) return stored;

    // Otherwise retry ONCE with the newer stored refresh token. It shares the ORIGINAL
    // deadline on purpose: the bound covers this whole refresh, which is what has to fit
    // inside the shared lease — a second full budget would not.
    try {
      consumedRefreshToken = stored.oauthRefreshToken!;
      tokens = await callTokenEndpoint(consumedRefreshToken);
    } catch (retryError) {
      if (retryError instanceof OAuthInvalidGrantError) invalidGrant(providerId);
      throw retryError;
    }
  }

  const refreshedAt = Date.now();
  const expiresAt =
    (tokens.expiresIn ? refreshedAt + tokens.expiresIn * 1000 : undefined) ??
    parseJwtExpiry(tokens.accessToken) ??
    refreshedAt + DEFAULT_TOKEN_TTL_MS;

  const nextKeyVaults: OAuthTokenKeyVaults = {
    oauthAccountId: tokens.accountId ?? keyVaults.oauthAccountId,
    oauthAccessToken: tokens.accessToken,
    // Keepalive anchor moves forward on every success; the backoff stamp is cleared in
    // the same write, so one good refresh ends the quiet period immediately.
    oauthLastRefreshAt: refreshedAt,
    oauthLastRefreshErrorAt: undefined,
    oauthRefreshToken: tokens.refreshToken,
    oauthTokenExpiresAt: expiresAt,
  };

  // Persist BEFORE returning: a rotated pair that only exists in memory strands
  // every other instance and the next request on this one (invalid_grant +
  // re-read still sees the consumed token and cannot self-heal).
  return persistRotatedKeyVaults(params, nextKeyVaults, consumedRefreshToken);
};

/**
 * Store-agnostic core of {@link ensureFreshOAuthToken}: same proactive-expiry,
 * single-flight, persist-then-use and invalid_grant self-heal policy, with the
 * persistence target and (optionally) a cross-instance lock supplied by the caller.
 */
export const ensureFreshOAuthTokenWithStore = async (
  params: EnsureFreshOAuthTokenWithStoreParams,
): Promise<OAuthTokenKeyVaults> => {
  const { config, flightKey, force, keyVaults } = params;

  // Not connected via OAuth (or nothing to refresh with) — leave untouched.
  if (!keyVaults.oauthAccessToken || !keyVaults.oauthRefreshToken) return keyVaults;

  if (!shouldRefreshOAuthToken({ config, force, keyVaults })) return keyVaults;

  let flight = inflight.get(flightKey);
  if (!flight) {
    const run = (lockedKeyVaults?: OAuthTokenKeyVaults) =>
      refreshAndPersist(lockedKeyVaults ? { ...params, keyVaults: lockedKeyVaults } : params);
    flight = (params.withRefreshLock ? params.withRefreshLock(run) : run()).finally(() =>
      inflight.delete(flightKey),
    );
    inflight.set(flightKey, flight);
  }

  return flight;
};

/**
 * Ensure the OAuth access token in `keyVaults` is fresh, refreshing and
 * persisting it when it is about to expire.
 *
 * Designed for providers with rotating refresh tokens (e.g. ChatGPT and SuperGrok):
 * - proactive refresh at `expiresAt - refreshSkewMs` (2 min by default, 24 h for ChatGPT
 *   Web), with the JWT `exp` claim as a fallback expiry signal
 * - forced keepalive every 3 days so an unused refresh token is not dropped upstream
 * - 5-minute backoff after a failed refresh, unless the access token is already expired
 * - in-process single-flight per user/provider
 * - persist-then-use ordering, with invalid_grant "re-read & retry once"
 *   self-healing for multi-instance rotation races
 *
 * KEEPALIVE FOR USER-OWNED VAULTS IS LAZY. There is no per-user background job: the
 * forced renewal happens on the next request that resolves this credential (chat,
 * connectivity check, model fetch). A personal connection nobody uses for months can
 * therefore still lapse — the user reconnects from provider settings, which is a
 * self-service fix. Only SHARED (platform) credentials get the background sweep, because
 * there the blast radius is every member of the instance and nobody but an admin can fix
 * it (`enterprise/services/aiCatalog/sharedOAuthKeepalive.ts`).
 *
 * Returns the key vaults to use for this request (possibly refreshed).
 * Throws `OAuthAuthorizationExpired` when the grant is irrecoverably invalid.
 */
export const ensureFreshOAuthToken = async (
  params: EnsureFreshOAuthTokenParams,
): Promise<OAuthTokenKeyVaults> => {
  const { config, db, keyVaults, providerId, userId, workspaceId } = params;

  return ensureFreshOAuthTokenWithStore({
    config,
    flightKey: `${userId}:${workspaceId ?? ''}:${providerId}`,
    keyVaults,
    providerId,
    store: {
      persist: (next) => persistKeyVaults(db, userId, providerId, next, workspaceId),
      read: () => readStoredKeyVaults(db, userId, providerId, workspaceId),
    },
  });
};

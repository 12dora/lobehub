import { AgentRuntimeError } from '@lobechat/model-runtime';
import { AgentRuntimeErrorType } from '@lobechat/types';
import debug from 'debug';

import { AiProviderModel } from '@/database/models/aiProvider';
import { type LobeChatDatabase } from '@/database/type';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { type OAuthDeviceFlowConfig } from '@/types/aiProvider';

import { OAuthInvalidGrantError, parseJwtExpiry } from './index';
import { getOAuthService } from './providers/githubCopilot';

const log = debug('lobe-server:oauth-token-refresh');

/**
 * Refresh the access token this long before it actually expires, so a request
 * dispatched right at the boundary doesn't hit a mid-flight 401.
 */
const REFRESH_SKEW_MS = 120_000;

/**
 * Deadline for ONE token-endpoint call. Deliberately below the shared refresh lease
 * (`LEASE_SECONDS = 30` in `enterprise/services/aiCatalog/sharedOAuthRefresh.ts`) with room
 * for the persist that follows: a call that outlives the lease lets a second instance
 * present the same rotating refresh token, and providers answer that reuse by revoking the
 * whole grant family — killing a shared credential for every user at once.
 */
const REFRESH_REQUEST_TIMEOUT_MS = 20_000;

// TODO(chatgptweb): E2 §1.5 refresh lifecycle beyond the proactive skew — a 24 h refresh
// skew, a 5-minute backoff after a transient token-endpoint failure, and a forced
// refresh-token keepalive every three days (an unused refresh token can be invalidated by
// the provider). Needs durable last-refresh/last-error timestamps plus a background
// keepalive job, so it is tracked as follow-up work rather than done inline here.

/**
 * Fallback access-token lifetime when the provider returns neither
 * `expires_in` nor a parseable JWT `exp` claim.
 */
const DEFAULT_TOKEN_TTL_MS = 3600 * 1000;

export interface OAuthTokenKeyVaults {
  oauthAccessToken?: string;
  oauthAccountId?: string;
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

export const isOAuthTokenExpiring = (keyVaults: OAuthTokenKeyVaults): boolean =>
  isExpiring(keyVaults);

const isExpiring = (keyVaults: OAuthTokenKeyVaults): boolean => {
  const now = Date.now();

  // Stored expiry is best-effort (the provider may not return expires_in),
  // so the JWT exp claim acts as a second opinion: expiring when EITHER
  // signal says so, and when neither is available we conservatively refresh.
  const storedExpiresAt = keyVaults.oauthTokenExpiresAt
    ? Number(keyVaults.oauthTokenExpiresAt)
    : undefined;
  const jwtExpiresAt = parseJwtExpiry(keyVaults.oauthAccessToken);

  if (!storedExpiresAt && !jwtExpiresAt) return true;

  if (storedExpiresAt && storedExpiresAt - now <= REFRESH_SKEW_MS) return true;

  return Boolean(jwtExpiresAt && jwtExpiresAt - now <= REFRESH_SKEW_MS);
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

const persistKeyVaults = async (
  db: LobeChatDatabase,
  userId: string,
  providerId: string,
  keyVaults: OAuthTokenKeyVaults,
  workspaceId?: string,
) => {
  const aiProviderModel = new AiProviderModel(db, userId, workspaceId);
  const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();

  await aiProviderModel.updateConfig(
    providerId,
    {
      keyVaults: {
        oauthAccountId: keyVaults.oauthAccountId,
        oauthAccessToken: keyVaults.oauthAccessToken,
        oauthRefreshToken: keyVaults.oauthRefreshToken,
        oauthTokenExpiresAt:
          keyVaults.oauthTokenExpiresAt === undefined
            ? undefined
            : String(keyVaults.oauthTokenExpiresAt),
      },
    },
    gateKeeper.encrypt,
    KeyVaultsGateKeeper.getUserKeyVaults,
  );
};

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
      !isExpiring(stored)
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

  let tokens;
  try {
    tokens = await service.refreshAccessToken(config, usedRefreshToken, refreshOptions);
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
    if (stored.oauthAccessToken && !isExpiring(stored)) return stored;

    // Otherwise retry ONCE with the newer stored refresh token. It shares the ORIGINAL
    // deadline on purpose: the bound covers this whole refresh, which is what has to fit
    // inside the shared lease — a second full budget would not.
    try {
      consumedRefreshToken = stored.oauthRefreshToken!;
      tokens = await service.refreshAccessToken(config, consumedRefreshToken, refreshOptions);
    } catch (retryError) {
      if (retryError instanceof OAuthInvalidGrantError) invalidGrant(providerId);
      throw retryError;
    }
  }

  const expiresAt =
    (tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined) ??
    parseJwtExpiry(tokens.accessToken) ??
    Date.now() + DEFAULT_TOKEN_TTL_MS;

  const nextKeyVaults: OAuthTokenKeyVaults = {
    oauthAccountId: tokens.accountId ?? keyVaults.oauthAccountId,
    oauthAccessToken: tokens.accessToken,
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
  const { flightKey, keyVaults } = params;

  // Not connected via OAuth (or nothing to refresh with) — leave untouched.
  if (!keyVaults.oauthAccessToken || !keyVaults.oauthRefreshToken) return keyVaults;

  if (!isExpiring(keyVaults)) return keyVaults;

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
 * - proactive refresh at `expiresAt - 2min`, with the JWT `exp` claim as a
 *   fallback expiry signal
 * - in-process single-flight per user/provider
 * - persist-then-use ordering, with invalid_grant "re-read & retry once"
 *   self-healing for multi-instance rotation races
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

import { AgentRuntimeError } from '@lobechat/model-runtime';
import { AgentRuntimeErrorType } from '@lobechat/types';
import debug from 'debug';

import { AiProviderModel } from '@/database/models/aiProvider';
import { type LobeChatDatabase } from '@/database/type';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { type OAuthDeviceFlowConfig } from '@/types/aiProvider';

import { OAuthDeviceFlowService, OAuthInvalidGrantError, parseJwtExpiry } from './index';

const log = debug('lobe-server:oauth-token-refresh');

/**
 * Refresh the access token this long before it actually expires, so a request
 * dispatched right at the boundary doesn't hit a mid-flight 401.
 */
const REFRESH_SKEW_MS = 120_000;

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

interface EnsureFreshOAuthTokenParams {
  config: OAuthDeviceFlowConfig;
  db: LobeChatDatabase;
  keyVaults: OAuthTokenKeyVaults;
  providerId: string;
  userId: string;
  workspaceId?: string;
}

/**
 * In-process single-flight registry: concurrent requests for the same
 * user/provider collapse onto one refresh HTTP call. Critical for rotating
 * refresh tokens (single use) — two parallel refreshes with the same token
 * would invalidate each other.
 */
const inflight = new Map<string, Promise<OAuthTokenKeyVaults>>();

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
  params: EnsureFreshOAuthTokenParams,
  nextKeyVaults: OAuthTokenKeyVaults,
): Promise<OAuthTokenKeyVaults> => {
  const { db, providerId, userId, workspaceId } = params;
  let lastError: unknown;

  for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      await persistKeyVaults(db, userId, providerId, nextKeyVaults, workspaceId);
      return nextKeyVaults;
    } catch (error) {
      lastError = error;
      log(
        'persist attempt %d/%d failed for %s:%s',
        attempt,
        PERSIST_MAX_ATTEMPTS,
        userId,
        providerId,
      );
      if (attempt < PERSIST_MAX_ATTEMPTS) await delay(PERSIST_RETRY_DELAY_MS * attempt);
    }
  }

  // Another instance may have won a race and written the same (or newer) pair.
  try {
    const stored = await readStoredKeyVaults(db, userId, providerId, workspaceId);
    if (
      stored.oauthAccessToken &&
      stored.oauthRefreshToken &&
      stored.oauthRefreshToken !== params.keyVaults.oauthRefreshToken &&
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
  params: EnsureFreshOAuthTokenParams,
): Promise<OAuthTokenKeyVaults> => {
  const { config, db, keyVaults, providerId, userId, workspaceId } = params;
  const service = new OAuthDeviceFlowService();
  const usedRefreshToken = keyVaults.oauthRefreshToken!;

  let tokens;
  try {
    tokens = await service.refreshAccessToken(config, usedRefreshToken);
  } catch (error) {
    if (!(error instanceof OAuthInvalidGrantError)) throw error;

    // invalid_grant self-heal: with rotating refresh tokens, "our" token being
    // rejected usually means another server instance already consumed it and
    // persisted a newer pair. Re-read the DB before declaring the grant dead.
    log('invalid_grant for %s:%s, re-reading stored credentials', userId, providerId);
    const stored = await readStoredKeyVaults(db, userId, providerId, workspaceId);

    // Same token in the DB as the one that was just rejected → truly dead.
    if (!stored.oauthRefreshToken || stored.oauthRefreshToken === usedRefreshToken) {
      throwInvalidGrant(providerId);
    }

    // Another instance rotated: its access token may already be fresh enough.
    if (stored.oauthAccessToken && !isExpiring(stored)) return stored;

    // Otherwise retry ONCE with the newer stored refresh token.
    try {
      tokens = await service.refreshAccessToken(config, stored.oauthRefreshToken!);
    } catch (retryError) {
      if (retryError instanceof OAuthInvalidGrantError) throwInvalidGrant(providerId);
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
  return persistRotatedKeyVaults(params, nextKeyVaults);
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
  const { keyVaults, providerId, userId, workspaceId } = params;

  // Not connected via OAuth (or nothing to refresh with) — leave untouched.
  if (!keyVaults.oauthAccessToken || !keyVaults.oauthRefreshToken) return keyVaults;

  if (!isExpiring(keyVaults)) return keyVaults;

  const flightKey = `${userId}:${workspaceId ?? ''}:${providerId}`;

  let flight = inflight.get(flightKey);
  if (!flight) {
    flight = refreshAndPersist(params).finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, flight);
  }

  return flight;
};

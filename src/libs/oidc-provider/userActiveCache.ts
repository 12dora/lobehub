import type { LobeChatDatabase } from '@lobechat/database';

import {
  assertUserActive,
  type AssertUserActiveOptions,
  isOIDCUserInactiveError,
  OIDCUserInactiveError,
} from './access-control';

const USER_ACTIVE_CACHE_TTL_MS = 5000;
const USER_ACTIVE_CACHE_MAX = 1024;

interface UserActiveCacheEntry {
  epoch: number;
  expiresAt: number;
  ok: boolean;
}

let epoch = 0;
const cache = new Map<string, UserActiveCacheEntry>();
const inflight = new Map<string, Promise<void>>();

const cacheKey = (userId: string, options: AssertUserActiveOptions): string => {
  const issuedAt =
    options.credentialIssuedAt instanceof Date &&
    !Number.isNaN(options.credentialIssuedAt.getTime())
      ? String(options.credentialIssuedAt.getTime())
      : '';
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
  return `${userId}\0${issuedAt}\0${sessionId}`;
};

const evictIfNeeded = (): void => {
  while (cache.size > USER_ACTIVE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') break;
    cache.delete(oldest);
  }
};

const remember = (key: string, ok: boolean): void => {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, {
    epoch,
    expiresAt: Date.now() + USER_ACTIVE_CACHE_TTL_MS,
    ok,
  });
  evictIfNeeded();
};

/**
 * Ban / invalidate writers bump this so a live-inactive user cannot ride the 5s TTL.
 *
 * `auth_invalidated_at` writes live in upstream `AdminUserModel` (packages/database).
 * Fork ban / revoke paths call {@link bumpUserActiveCacheEpoch} after commit.
 * Cross-instance invalidation relies on the small TTL (documented, not Redis).
 */
export const bumpUserActiveCacheEpoch = (): void => {
  epoch += 1;
  cache.clear();
  inflight.clear();
};

/**
 * 5s process TTL cache around {@link assertUserActive}.
 * Keyed by userId + credentialIssuedAt + sessionId; invalidated by epoch bump.
 */
export const assertUserActiveCached = async (
  db: LobeChatDatabase,
  userId: string,
  options: AssertUserActiveOptions = {},
): Promise<void> => {
  const key = cacheKey(userId, options);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.epoch === epoch && hit.expiresAt > now) {
    if (hit.ok) return;
    throw new OIDCUserInactiveError();
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const flightEpoch = epoch;
  const flight = (async () => {
    try {
      await assertUserActive(db, userId, options);
      if (flightEpoch === epoch) remember(key, true);
    } catch (error) {
      if (isOIDCUserInactiveError(error) && flightEpoch === epoch) {
        remember(key, false);
      }
      throw error;
    }
  })().finally(() => {
    if (inflight.get(key) === flight) inflight.delete(key);
  });

  inflight.set(key, flight);
  return flight;
};

/** Test helper. */
export const resetUserActiveCacheForTest = (): void => {
  epoch = 0;
  cache.clear();
  inflight.clear();
};

export { USER_ACTIVE_CACHE_TTL_MS };

/**
 * Fork helper for the per-request `assertUserActive` cache.
 *
 * Implementation lives next to the upstream checker so `packages/trpc` can
 * import it without violating the packages→enterprise reverse-import rule.
 * Ban / revoke flows bump the epoch from this module.
 */
export {
  assertUserActiveCached,
  bumpUserActiveCacheEpoch,
  resetUserActiveCacheForTest,
  USER_ACTIVE_CACHE_TTL_MS,
} from '@/libs/oidc-provider/userActiveCache';

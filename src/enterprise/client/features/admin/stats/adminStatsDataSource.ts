import { adminStatsService } from '@/enterprise/client/services/adminStats';
import { ADMIN_GLOBAL_STATS_SCOPE, type StatsDataSource } from '@/features/SettingsStats';
import type { UserDisplay } from '@/routes/(main)/settings/stats/types';
import type { UsageLog, UsageRecordItem } from '@/types/usage/usageRecord';

/** Cap identity labels retained for GroupBy.User charts (LRU by Map insertion order). */
export const ADMIN_STATS_USER_DISPLAY_CACHE_MAX = 500;

/** Historical labels retained across queries for transient partial responses. */
const userDisplayCache = new Map<string, UserDisplay>();

/** Every identity returned by the currently rendered grouped-usage query. */
const currentUserDisplayMap = new Map<string, UserDisplay>();

/** Stable aliases for identities without a display name in the current query. */
const unknownUserIndexes = new Map<string, number>();

/**
 * Remember/update historical user display labels from authoritative usage rows.
 * Always overwrites existing entries so renames are visible without reload.
 * Evicts the least-recently-used key when the cache exceeds the cap.
 */
const rememberHistoricalUsersFromUsage = (
  records: Array<{ userDisplay?: string; userId?: string }>,
) => {
  for (const row of records) {
    if (!row.userId || !row.userDisplay) continue;
    const next: UserDisplay = {
      avatar: null,
      name: row.userDisplay,
    };
    // Re-insert to mark as most recently used.
    if (userDisplayCache.has(row.userId)) {
      userDisplayCache.delete(row.userId);
    }
    userDisplayCache.set(row.userId, next);
    while (userDisplayCache.size > ADMIN_STATS_USER_DISPLAY_CACHE_MAX) {
      const oldest = userDisplayCache.keys().next().value;
      if (oldest === undefined) break;
      userDisplayCache.delete(oldest);
    }
  }
};

/**
 * Replace labels for the currently rendered grouped-usage result.
 * This map is intentionally unbounded by the historical LRU cap: every label
 * returned for one response must remain available while that response is shown.
 */
export const rememberCurrentUsersFromUsage = (
  records: Array<{ userDisplay?: string; userId?: string }>,
) => {
  currentUserDisplayMap.clear();
  unknownUserIndexes.clear();
  for (const row of records) {
    if (!row.userId || !row.userDisplay) continue;
    currentUserDisplayMap.set(row.userId, { avatar: null, name: row.userDisplay });
  }
  rememberHistoricalUsersFromUsage(records);
};

/** Clear the display cache (account/scope transition or tests). */
export const resetAdminStatsUserDisplayCache = () => {
  currentUserDisplayMap.clear();
  unknownUserIndexes.clear();
  userDisplayCache.clear();
};

/** Test / diagnostics helper — current bounded cache size. */
export const getAdminStatsUserDisplayCacheSize = () => userDisplayCache.size;

/** Test / diagnostics helper — identities retained for the active grouped result. */
export const getAdminStatsCurrentUserDisplaySize = () => currentUserDisplayMap.size;

/** Platform-global stats data source for admin.stats (scoped SWR keys). */
export const adminGlobalStatsDataSource: StatsDataSource = {
  activitySeries: (params) => adminStatsService.activitySeries(params),
  countAgents: (params) => adminStatsService.countAgents(params),
  countMessages: (params) => adminStatsService.countMessages(params),
  countTopics: (params) => adminStatsService.countTopics(params),
  findAndGroupByDay: async (params) => {
    const logs = await adminStatsService.usageFindAndGroupByDay(params);
    rememberCurrentUsersFromUsage(logs.flatMap((log) => log.records ?? []));
    // Rows are UsageRecordItem & { userDisplay }; assignable to UsageLog.
    return logs as UsageLog[];
  },
  findByMonth: async (params) => {
    const rows = await adminStatsService.usageFindByMonth(params);
    rememberHistoricalUsersFromUsage(rows);
    return rows as UsageRecordItem[];
  },
  getHeatmaps: () => adminStatsService.getHeatmaps(),
  getMaxTaskDuration: (params) => adminStatsService.getMaxTaskDuration(params),
  getTokenHeatmaps: () => adminStatsService.getTokenHeatmaps(),
  rankAgents: (limit, params) => adminStatsService.rankAgents(limit, params),
  // Server default limit (10); no limit param on StatsDataSource.rankModels.
  rankModels: (params) => adminStatsService.rankModels(params),
  // `admin.stats.rankTopics` answers with an envelope ({ contentAccessMode, items }) because
  // the audit policy travels with the rows; the shared widget contract stays a bare array, and
  // a `disabled` policy never reaches here — the procedure throws FORBIDDEN instead.
  rankTopics: async (limit, params) => (await adminStatsService.rankTopics(limit, params)).items,
  rankUsers: (limit, params) => adminStatsService.rankUsers(limit, params),
  scopeKey: ADMIN_GLOBAL_STATS_SCOPE,
  usageDailyTokenTotals: (params) => adminStatsService.usageDailyTokenTotals(params),
  userTotals: (params) => adminStatsService.userTotals(params?.activeDays, params),
};

/**
 * Resolve userId → display for admin GroupBy.User.
 * Populated when usage rows are fetched (userDisplay joined server-side).
 */
export const resolveAdminStatsUser = (
  userId: string,
  unknownUserLabel: (index: number) => string,
): UserDisplay => {
  const current = currentUserDisplayMap.get(userId);
  if (current) return current;

  const hit = userDisplayCache.get(userId);
  if (!hit) {
    const existingIndex = unknownUserIndexes.get(userId);
    const index = existingIndex ?? unknownUserIndexes.size + 1;
    unknownUserIndexes.set(userId, index);
    return { avatar: null, name: unknownUserLabel(index) };
  }
  // Touch LRU order on read.
  userDisplayCache.delete(userId);
  userDisplayCache.set(userId, hit);
  return hit;
};

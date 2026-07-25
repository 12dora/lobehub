import { adminStatsService } from '@/enterprise/client/services/adminStats';
import { ADMIN_GLOBAL_STATS_SCOPE, type StatsDataSource } from '@/features/SettingsStats';
import type { UserDisplay } from '@/routes/(main)/settings/stats/types';
import type { UsageLog, UsageRecordItem } from '@/types/usage/usageRecord';

/** Cap identity labels retained for GroupBy.User charts (LRU by Map insertion order). */
export const ADMIN_STATS_USER_DISPLAY_CACHE_MAX = 500;

/** Filled as global usage rows stream in — drives resolveUser for GroupBy.User. */
const userDisplayCache = new Map<string, UserDisplay>();

/**
 * Remember/update user display labels from authoritative usage rows.
 * Always overwrites existing entries so renames are visible without reload.
 * Evicts the least-recently-used key when the cache exceeds the cap.
 */
export const rememberUsersFromUsage = (
  records: Array<{ userDisplay?: string; userId?: string }>,
) => {
  for (const row of records) {
    if (!row.userId) continue;
    const next: UserDisplay = {
      avatar: null,
      name: row.userDisplay || row.userId,
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

/** Clear the display cache (account/scope transition or tests). */
export const resetAdminStatsUserDisplayCache = () => {
  userDisplayCache.clear();
};

/** Test / diagnostics helper — current bounded cache size. */
export const getAdminStatsUserDisplayCacheSize = () => userDisplayCache.size;

/** Platform-global stats data source for admin.stats (scoped SWR keys). */
export const adminGlobalStatsDataSource: StatsDataSource = {
  countAgents: (params) => adminStatsService.countAgents(params),
  countMessages: (params) => adminStatsService.countMessages(params),
  countTopics: (params) => adminStatsService.countTopics(params),
  findAndGroupByDay: async (mo) => {
    const logs = await adminStatsService.usageFindAndGroupByDay(mo);
    for (const log of logs) {
      rememberUsersFromUsage(log.records ?? []);
    }
    // Rows are UsageRecordItem & { userDisplay }; assignable to UsageLog.
    return logs as UsageLog[];
  },
  findByMonth: async (mo) => {
    const rows = await adminStatsService.usageFindByMonth(mo);
    rememberUsersFromUsage(rows);
    return rows as UsageRecordItem[];
  },
  getHeatmaps: () => adminStatsService.getHeatmaps(),
  getMaxTaskDuration: () => adminStatsService.getMaxTaskDuration(),
  getTokenHeatmaps: () => adminStatsService.getTokenHeatmaps(),
  rankAgents: (limit) => adminStatsService.rankAgents(limit),
  // Server default limit (10); no limit param on StatsDataSource.rankModels.
  rankModels: () => adminStatsService.rankModels(),
  rankTopics: (limit) => adminStatsService.rankTopics(limit),
  scopeKey: ADMIN_GLOBAL_STATS_SCOPE,
};

/**
 * Resolve userId → display for admin GroupBy.User.
 * Populated when usage rows are fetched (userDisplay joined server-side).
 */
export const resolveAdminStatsUser = (userId: string): UserDisplay => {
  const hit = userDisplayCache.get(userId);
  if (!hit) return { avatar: null, name: userId };
  // Touch LRU order on read.
  userDisplayCache.delete(userId);
  userDisplayCache.set(userId, hit);
  return hit;
};

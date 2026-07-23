import { adminStatsService } from '@/enterprise/client/services/adminStats';
import {
  ADMIN_GLOBAL_STATS_SCOPE,
  type StatsDataSource,
} from '@/routes/(main)/settings/stats/features/StatsDataSource';
import type { UserDisplay } from '@/routes/(main)/settings/stats/types';
import type { UsageLog, UsageRecordItem } from '@/types/usage/usageRecord';

/** Filled as global usage rows stream in — drives resolveUser for GroupBy.User. */
const userDisplayCache = new Map<string, UserDisplay>();

const rememberUsersFromUsage = (records: Array<{ userDisplay?: string; userId?: string }>) => {
  for (const row of records) {
    if (!row.userId) continue;
    if (!userDisplayCache.has(row.userId)) {
      userDisplayCache.set(row.userId, {
        avatar: null,
        name: row.userDisplay || row.userId,
      });
    }
  }
};

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
export const resolveAdminStatsUser = (userId: string): UserDisplay =>
  userDisplayCache.get(userId) ?? { avatar: null, name: userId };

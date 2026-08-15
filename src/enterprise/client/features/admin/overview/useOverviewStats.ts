import {
  adminStatsService,
  type AdminStatsUserRankItem,
  type AdminStatsUserRankOrderBy,
} from '@/enterprise/client/services/adminStats';
import { ADMIN_GLOBAL_STATS_SCOPE } from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';

import type { AdminTimeRangeBounds } from '../primitives/timeRange.utils';
import { OVERVIEW_RANK_LIMIT } from './constants';

const scope = ADMIN_GLOBAL_STATS_SCOPE;

/** Only the window fields reach the API — the label/key are presentation-only. */
const windowOf = (range?: AdminTimeRangeBounds) => ({
  endAt: range?.endAt,
  startAt: range?.startAt,
});

export interface OverviewKpiData {
  agents: number;
  messages: number;
  topics: number;
  usersActive: number;
  usersTotal: number;
}

/** Platform user totals + in-window counts for messages / topics / agents. */
export const useOverviewKpis = (range?: AdminTimeRangeBounds) => {
  const window = windowOf(range);

  return useClientDataSWR(
    ['admin-stats:overview-kpi', scope, window.startAt, window.endAt],
    async (): Promise<OverviewKpiData> => {
      // userTotals avoids the three unused lifetime table scans from totals().
      const [users, messages, topics, agents] = await Promise.all([
        adminStatsService.userTotals(undefined, window),
        adminStatsService.countMessages(window),
        adminStatsService.countTopics(window),
        adminStatsService.countAgents(window),
      ]);

      return {
        agents,
        messages,
        topics,
        usersActive: users.usersActive,
        usersTotal: users.usersTotal,
      };
    },
  );
};

/** Daily token totals across the selected window for the usage trend chart. */
export const useOverviewUsageTrend = (range?: AdminTimeRangeBounds) => {
  const window = windowOf(range);

  return useClientDataSWR(
    ['admin-stats:overview-usage-day', scope, window.startAt, window.endAt],
    async () => {
      const rows = await adminStatsService.usageDailyTokenTotals(window);
      return rows.map((row) => ({ day: row.day, tokens: Number(row.totalTokens) || 0 }));
    },
  );
};

/** Top models by message count in the window (platform-wide). */
export const useOverviewModelRank = (range?: AdminTimeRangeBounds) => {
  const window = windowOf(range);

  return useClientDataSWR(
    ['admin-stats:overview-rank-models', scope, window.startAt, window.endAt],
    async () => {
      const rows = await adminStatsService.rankModels(window);
      return rows.slice(0, OVERVIEW_RANK_LIMIT);
    },
  );
};

/** Top agents by topic count in the window (platform-wide). */
export const useOverviewAgentRank = (range?: AdminTimeRangeBounds) => {
  const window = windowOf(range);

  return useClientDataSWR(
    ['admin-stats:overview-rank-agents', scope, OVERVIEW_RANK_LIMIT, window.startAt, window.endAt],
    async () => adminStatsService.rankAgents(OVERVIEW_RANK_LIMIT, window),
  );
};

/**
 * Top users in the window for one metric.
 *
 * The metric is part of the request (and of the SWR key): the server ranks and truncates
 * in SQL, so re-sorting a fetched top-5 client-side would show the wrong five users for
 * every metric except the one that was ordered by.
 */
export const useOverviewUserRank = (
  range?: AdminTimeRangeBounds,
  orderBy: AdminStatsUserRankOrderBy = 'totalTokens',
) => {
  const window = windowOf(range);

  return useClientDataSWR(
    [
      'admin-stats:overview-rank-users',
      scope,
      OVERVIEW_RANK_LIMIT,
      orderBy,
      window.startAt,
      window.endAt,
    ],
    async (): Promise<AdminStatsUserRankItem[]> =>
      adminStatsService.rankUsers(OVERVIEW_RANK_LIMIT, { ...window, orderBy }),
  );
};

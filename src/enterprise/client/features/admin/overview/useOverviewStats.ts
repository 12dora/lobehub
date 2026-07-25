import { adminStatsService } from '@/enterprise/client/services/adminStats';
import { ADMIN_GLOBAL_STATS_SCOPE } from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';

import { OVERVIEW_RANK_LIMIT, OVERVIEW_WINDOW_DAYS } from './constants';
import { currentMonthKey, overviewWindowStartDate } from './utils';

const scope = ADMIN_GLOBAL_STATS_SCOPE;

export interface OverviewKpiData {
  agents: number;
  messages: number;
  topics: number;
  usersActive: number;
  usersTotal: number;
}

/** Platform user totals + 30-day counts for messages / topics / agents. */
export const useOverviewKpis = () => {
  const days = OVERVIEW_WINDOW_DAYS;
  const startDate = overviewWindowStartDate(days);

  return useClientDataSWR(
    ['admin-stats:overview-kpi', scope, days],
    async (): Promise<OverviewKpiData> => {
      // userTotals avoids the three unused lifetime table scans from totals().
      const [users, messages, topics, agents] = await Promise.all([
        adminStatsService.userTotals(days),
        adminStatsService.countMessages({ startDate }),
        adminStatsService.countTopics({ startDate }),
        adminStatsService.countAgents({ startDate }),
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

/** Current-month daily token totals for the usage trend chart. */
export const useOverviewUsageTrend = () => {
  const mo = currentMonthKey();

  return useClientDataSWR(['admin-stats:overview-usage-day', scope, mo], async () => {
    const rows = await adminStatsService.usageDailyTokenTotals(mo);
    return rows.map((row) => ({ day: row.day, tokens: Number(row.totalTokens) || 0 }));
  });
};

/** Top models by message count (platform-wide). */
export const useOverviewModelRank = () =>
  useClientDataSWR(['admin-stats:overview-rank-models', scope], async () => {
    const rows = await adminStatsService.rankModels();
    return rows.slice(0, OVERVIEW_RANK_LIMIT);
  });

/** Top agents by topic count (platform-wide). */
export const useOverviewAgentRank = () =>
  useClientDataSWR(['admin-stats:overview-rank-agents', scope, OVERVIEW_RANK_LIMIT], async () =>
    adminStatsService.rankAgents(OVERVIEW_RANK_LIMIT),
  );

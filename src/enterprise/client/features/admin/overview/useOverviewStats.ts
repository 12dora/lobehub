import { adminStatsService } from '@/enterprise/client/services/adminStats';
import { useClientDataSWR } from '@/libs/swr';
import { ADMIN_GLOBAL_STATS_SCOPE } from '@/routes/(main)/settings/stats/features/StatsDataSource';
import type { UsageLog } from '@/types/usage/usageRecord';

import { OVERVIEW_RANK_LIMIT, OVERVIEW_WINDOW_DAYS } from './constants';
import { currentMonthKey, overviewWindowStartDate, toDailyTokenTrend } from './utils';

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
      const [totals, messages, topics, agents] = await Promise.all([
        adminStatsService.totals(days),
        adminStatsService.countMessages({ startDate }),
        adminStatsService.countTopics({ startDate }),
        adminStatsService.countAgents({ startDate }),
      ]);

      return {
        agents,
        messages,
        topics,
        usersActive: totals.usersActive,
        usersTotal: totals.usersTotal,
      };
    },
  );
};

/** Current-month daily token totals for the usage trend chart. */
export const useOverviewUsageTrend = () => {
  const mo = currentMonthKey();

  return useClientDataSWR(['admin-stats:overview-usage-day', scope, mo], async () => {
    const logs = (await adminStatsService.usageFindAndGroupByDay(mo)) as UsageLog[];
    return toDailyTokenTrend(logs);
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

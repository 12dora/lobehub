import { lambdaClient } from '@/libs/trpc/client';

/**
 * Explicit instant window shared by every filterable admin stats query.
 * `startAt` / `endAt` are ISO-8601 instants describing a half-open `[startAt, endAt)`
 * window and take precedence over the legacy day-string / month inputs.
 */
export interface AdminStatsRangeParams {
  endAt?: string;
  startAt?: string;
  userId?: string;
}

type CountDateParams = AdminStatsRangeParams & {
  endDate?: string;
  range?: [string, string];
  startDate?: string;
};

type UsageParams = AdminStatsRangeParams & { mo?: string };

/** Sort metric for `rankUsers` — applied in SQL, so the result is the true top-N. */
export type AdminStatsUserRankOrderBy = 'cost' | 'messages' | 'totalTokens';

type UserRankParams = AdminStatsRangeParams & { orderBy?: AdminStatsUserRankOrderBy };

/** Typed client boundary for platform-wide admin data statistics. */
class AdminStatsService {
  countAgents = async (params?: CountDateParams) =>
    lambdaClient.admin.stats.countAgents.query(params);

  countMessages = async (params?: CountDateParams) =>
    lambdaClient.admin.stats.countMessages.query(params);

  countTopics = async (params?: CountDateParams) =>
    lambdaClient.admin.stats.countTopics.query(params);

  getHeatmaps = async () => lambdaClient.admin.stats.getHeatmaps.query();

  getMaxTaskDuration = async () => lambdaClient.admin.stats.getMaxTaskDuration.query();

  getTokenHeatmaps = async () => lambdaClient.admin.stats.getTokenHeatmaps.query();

  rankAgents = async (limit?: number, params?: AdminStatsRangeParams) =>
    lambdaClient.admin.stats.rankAgents.query({ limit, ...params });

  /** Uses server default limit (10) — matches personal messageService.rankModels(). */
  rankModels = async (params?: AdminStatsRangeParams) =>
    lambdaClient.admin.stats.rankModels.query({ ...params });

  rankTopics = async (limit?: number, params?: AdminStatsRangeParams) =>
    lambdaClient.admin.stats.rankTopics.query({ limit, ...params });

  /**
   * Top users by usage in the window. Admin-only (no personal counterpart).
   * `orderBy` is applied server-side — never re-sort a page of rows client-side, that
   * would rank the wrong top-N for every metric but the one that was fetched.
   */
  rankUsers = async (limit?: number, params?: UserRankParams) =>
    lambdaClient.admin.stats.rankUsers.query({ limit, ...params });

  totals = async (activeDays?: number) => lambdaClient.admin.stats.totals.query({ activeDays });

  /** User totals only — avoids unused lifetime message/topic/agent counts. */
  userTotals = async (activeDays?: number, params?: AdminStatsRangeParams) =>
    lambdaClient.admin.stats.userTotals.query({ activeDays, ...params });

  /** Bounded daily token series for the overview chart (no per-message payload). */
  usageDailyTokenTotals = async (params?: UsageParams | string) =>
    lambdaClient.admin.stats.usageDailyTokenTotals.query(
      typeof params === 'string' ? { mo: params } : params,
    );

  usageFindAndGroupByDay = async (params?: UsageParams | string) =>
    lambdaClient.admin.stats.usageFindAndGroupByDay.query(
      typeof params === 'string' ? { mo: params } : params,
    );

  usageFindByMonth = async (params?: UsageParams | string) =>
    lambdaClient.admin.stats.usageFindByMonth.query(
      typeof params === 'string' ? { mo: params } : params,
    );
}

export const adminStatsService = new AdminStatsService();

/** Row shape of `admin.stats.rankUsers` (mirrors the server contract). */
export interface AdminStatsUserRankItem {
  avatar: string | null;
  cost: number;
  inputTokens: number;
  messages: number;
  name: string;
  outputTokens: number;
  totalTokens: number;
  userId: string;
}

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

/** Bucket width of an activity series; omitted lets the server derive it from the span. */
export type AdminStatsActivityGranularity = 'day' | 'hour' | 'week';
/** What a bucket counts: every message, or the assistant-gated token sum (default). */
export type AdminStatsActivityMetric = 'messages' | 'tokens';

export interface AdminStatsActivitySeriesParams extends AdminStatsRangeParams {
  granularity?: AdminStatsActivityGranularity;
  metric?: AdminStatsActivityMetric;
  /** IANA zone the buckets are expressed in. Defaults to `UTC` on the server. */
  timeZone?: string;
}

/** One zero-filled bucket of `admin.stats.activitySeries` (mirrors the server contract). */
export interface AdminStatsActivityPoint {
  /** `YYYY-MM-DDTHH:00` for hour buckets, `YYYY-MM-DD` for day / week (Monday) buckets. */
  bucket: string;
  count: number;
  /** 0..4 heatmap intensity. */
  level: number;
}

/** Typed client boundary for platform-wide admin data statistics. */
class AdminStatsService {
  /**
   * Zero-filled activity buckets for the selected window. The server derives the bucket
   * width from the span unless `granularity` pins one, and defaults to the last 30 days.
   */
  activitySeries = async (
    params?: AdminStatsActivitySeriesParams,
  ): Promise<AdminStatsActivityPoint[]> => lambdaClient.admin.stats.activitySeries.query(params);

  countAgents = async (params?: CountDateParams) =>
    lambdaClient.admin.stats.countAgents.query(params);

  countMessages = async (params?: CountDateParams) =>
    lambdaClient.admin.stats.countMessages.query(params);

  countTopics = async (params?: CountDateParams) =>
    lambdaClient.admin.stats.countTopics.query(params);

  getHeatmaps = async () => lambdaClient.admin.stats.getHeatmaps.query();

  /** Longest completed task; an explicit window narrows it, omitted it keeps the trailing year. */
  getMaxTaskDuration = async (params?: AdminStatsRangeParams) =>
    lambdaClient.admin.stats.getMaxTaskDuration.query(params);

  getTokenHeatmaps = async () => lambdaClient.admin.stats.getTokenHeatmaps.query();

  rankAgents = async (limit?: number, params?: AdminStatsRangeParams) =>
    lambdaClient.admin.stats.rankAgents.query({ limit, ...params });

  /** Uses server default limit (10) — matches personal messageService.rankModels(). */
  rankModels = async (params?: AdminStatsRangeParams) =>
    lambdaClient.admin.stats.rankModels.query({ ...params });

  rankTopics = async (
    limit?: number,
    params?: AdminStatsRangeParams,
  ): Promise<AdminStatsTopicRankResult> =>
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

/** One ranked topic from `admin.stats.rankTopics` (titles are credential-masked). */
export interface AdminStatsTopicRankItem {
  agentId: string | null;
  count: number;
  id: string;
  title: string | null;
  userId: string;
}

/**
 * Envelope of `admin.stats.rankTopics`. `disabled` is not a success mode — the
 * procedure throws FORBIDDEN / `audit_content_access_disabled` instead.
 */
export interface AdminStatsTopicRankResult {
  contentAccessMode: 'content_allowed' | 'metadata_only';
  items: AdminStatsTopicRankItem[];
}

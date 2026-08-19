/**
 * Shared SQL fragments, caps, and usage-row types for platform global stats.
 */
import { INBOX_SESSION_ID } from '@lobechat/const';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { SQL } from 'drizzle-orm';
import { eq, isNull, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { MessageMetadata } from '@/types/message';
import type { UsageLog, UsageRecordItem } from '@/types/usage/usageRecord';

import { agents, messages, users } from '../../schemas';
import { genEndDateWhere, genRangeWhere, genStartDateWhere } from '../../utils/genWhere';
import type { ActivityMetric, StatsRangeParams } from './globalStatsRange';
import { genInstantRangeWhere, resolveStatsRange } from './globalStatsRange';

dayjs.extend(utc);

/**
 * Token usage of a single message row, in the shape every token aggregate should agree on:
 * the recorded `totalTokens` wins (current `usage`, legacy `metadata.usage`, flat
 * `metadata`), and input + output are summed only when no total was recorded at all.
 * Shared by {@link PlatformGlobalStatsModel.getTokenHeatmaps} and findActivitySeries so the
 * admin activity card and the heatmap can never disagree about the same rows.
 */
export const messageTotalTokensSql = () => sql<number>`COALESCE(
  (${messages.usage}->>'totalTokens')::double precision,
  (${messages.metadata}->'usage'->>'totalTokens')::double precision,
  (${messages.metadata}->>'totalTokens')::double precision,
  COALESCE(
    (${messages.usage}->>'totalInputTokens')::double precision,
    (${messages.metadata}->'usage'->>'totalInputTokens')::double precision,
    (${messages.metadata}->>'totalInputTokens')::double precision,
    0
  ) + COALESCE(
    (${messages.usage}->>'totalOutputTokens')::double precision,
    (${messages.metadata}->'usage'->>'totalOutputTokens')::double precision,
    (${messages.metadata}->>'totalOutputTokens')::double precision,
    0
  )
)`;

/**
 * Cost / input / output COALESCE chains for rank, chart, and usage-detail SQL.
 * Always read the dedicated `usage` column first, then nested `metadata.usage`,
 * then the deprecated flat `metadata` fields. Input and output are summed
 * independently — unlike {@link messageTotalTokensSql}, these never prefer a
 * recorded `totalTokens` (activity/heatmap callers stay on that helper).
 */
export const usageCostSql = () => sql<number>`COALESCE(
  (${messages.usage}->>'cost')::double precision,
  (${messages.metadata}->'usage'->>'cost')::double precision,
  (${messages.metadata}->>'cost')::double precision,
  0
)`;

export const usageInputTokensSql = () => sql<number>`COALESCE(
  (${messages.usage}->>'totalInputTokens')::double precision,
  (${messages.metadata}->'usage'->>'totalInputTokens')::double precision,
  (${messages.metadata}->>'totalInputTokens')::double precision,
  0
)`;

export const usageOutputTokensSql = () => sql<number>`COALESCE(
  (${messages.usage}->>'totalOutputTokens')::double precision,
  (${messages.metadata}->'usage'->>'totalOutputTokens')::double precision,
  (${messages.metadata}->>'totalOutputTokens')::double precision,
  0
)`;

/**
 * Non-virtual agents including legacy `virtual IS NULL` rows (DB-009).
 * Shared by {@link PlatformGlobalStatsModel.countAgents} and rankAgents so totals
 * and rankings operate on the same population. Inbox slug is always included.
 */
export const isNonVirtualAgentSql = () =>
  or(eq(agents.slug, INBOX_SESSION_ID), eq(agents.virtual, false), isNull(agents.virtual));

/**
 * Hard safety cap for uncapped {@link PlatformGlobalStatsModel.findByDateRange} /
 * {@link PlatformGlobalStatsModel.findByMonth} drains. Prevents unbounded in-memory
 * materialization of raw message rows (admin OOM risk). Prefer keyset paging via
 * findByDateRangePage / findByMonthPage for large ranges; charts use findAndGroupByDay.
 */
export const MAX_USAGE_DETAIL_ROWS = 20000;

/**
 * Chart path cardinality caps for {@link PlatformGlobalStatsModel.findAndGroupByDay}.
 * Per-user series stays populated for GroupBy.User; long-tail users fold into `other`.
 */
export const GROUP_BY_DAY_TOP_USERS = 20;
/** Max distinct model values kept per day (remainder rolled into `__other__` model). */
export const GROUP_BY_DAY_MAX_MODELS = 30;
/** Max distinct provider values kept per day (remainder rolled into `__other__` provider). */
export const GROUP_BY_DAY_MAX_PROVIDERS = 20;
/** Synthetic userId for aggregated long-tail users (never blank). */
export const GROUP_BY_DAY_OTHER_USER_ID = '__other__';

/** Legacy calendar-day filters kept for back-compat with the `countDateInput` shape. */
export interface CountDateParams {
  endDate?: string;
  range?: [string, string];
  startDate?: string;
}

/** Build the half-open instant predicate only when an explicit bound was supplied. */
export const explicitRangeWhere = (
  params: StatsRangeParams | undefined,
  key: AnyPgColumn,
): SQL | undefined => {
  if (!params || (params.startAt === undefined && params.endAt === undefined)) return;
  return genInstantRangeWhere(
    resolveStatsRange({ endAt: params.endAt, startAt: params.startAt }),
    key,
  );
};

/** Explicit instants win over the legacy `range` / `startDate` / `endDate` triple. */
export const legacyDateWheres = (
  explicit: SQL | undefined,
  params: CountDateParams | undefined,
  key: AnyPgColumn,
): Array<SQL | undefined> => {
  if (explicit) return [explicit];
  return [
    params?.range ? genRangeWhere(params.range, key, (date) => date.toDate()) : undefined,
    params?.endDate ? genEndDateWhere(params.endDate, key, (date) => date.toDate()) : undefined,
    params?.startDate
      ? genStartDateWhere(params.startDate, key, (date) => date.toDate())
      : undefined,
  ];
};

/** Usage row with platform-global user display name (join users). */
export type GlobalUsageRecordItem = UsageRecordItem & { userDisplay: string };

export type GlobalUsageLog = Omit<UsageLog, 'records'> & {
  records: GlobalUsageRecordItem[];
};

/** Metric the admin 用户排行 sorts by (always DESC, tie-break `userId` ASC). */
export type UserRankOrderBy = 'cost' | 'messages' | 'totalTokens';

/** One row of the admin 用户排行 (users ranked by token usage). */
export type UserRankItem = {
  /** users.avatar; null when unset or the account row is gone. */
  avatar: string | null;
  cost: number;
  inputTokens: number;
  /** Messages authored in the window (all roles). */
  messages: number;
  /** fullName → username → email → id (never a raw email field of its own). */
  name: string;
  outputTokens: number;
  totalTokens: number;
  userId: string;
};

export type GlobalStatsTotals = {
  agents: number;
  messages: number;
  topics: number;
  /** Users active within the last `activeDays` (by lastActiveAt). */
  usersActive: number;
  usersTotal: number;
};

// Heatmap intensity buckets. The message heatmap keys off an absolute count (one level per
// HEATMAP_MESSAGES_PER_LEVEL messages); the token heatmap scales relative to the busiest day.
// Both clamp to MAX_HEATMAP_LEVEL — the two formulas are intentionally different.
export const MAX_HEATMAP_LEVEL = 4;
export const HEATMAP_MESSAGES_PER_LEVEL = 5;

/** The two heatmap formulas above, applied to one activity bucket. */
export const activityLevel = (metric: ActivityMetric, value: number, maxValue: number): number => {
  if (value <= 0) return 0;
  if (metric === 'messages')
    return Math.min(MAX_HEATMAP_LEVEL, Math.ceil(value / HEATMAP_MESSAGES_PER_LEVEL));
  return maxValue > 0
    ? Math.min(MAX_HEATMAP_LEVEL, Math.max(1, Math.ceil((value / maxValue) * MAX_HEATMAP_LEVEL)))
    : 0;
};

export const userDisplaySql = sql<string>`COALESCE(NULLIF(TRIM(${users.fullName}), ''), NULLIF(TRIM(${users.username}), ''), NULLIF(TRIM(${users.email}), ''), ${users.id})`;

/** Shared `.select({...})` fields for usage-detail keyset and bounded-month pages. */
export const selectUsageDetailProjection = {
  createdAt: messages.createdAt,
  id: messages.id,
  metadata: messages.metadata,
  model: messages.model,
  provider: messages.provider,
  role: messages.role,
  usage: messages.usage,
  userDisplay: userDisplaySql,
  userId: messages.userId,
};

/**
 * Prefer the dedicated `usage` column, then nested metadata.usage /
 * metadata.performance, then deprecated flat metadata fields (parity with
 * UsageRecordService.findByDateRange).
 */
export const toGlobalUsageRecordItem = (spend: {
  createdAt: Date;
  id: string;
  metadata: unknown;
  model: string | null;
  provider: string | null;
  usage: MessageMetadata['usage'] | null;
  userDisplay: string | null;
  userId: string;
}): GlobalUsageRecordItem => {
  const metadata = spend.metadata as MessageMetadata | null;
  const usage = spend.usage ?? metadata?.usage;
  const performance = metadata?.performance;
  const totalInputTokens = usage?.totalInputTokens ?? metadata?.totalInputTokens ?? 0;
  const totalOutputTokens = usage?.totalOutputTokens ?? metadata?.totalOutputTokens ?? 0;
  return {
    createdAt: spend.createdAt,
    id: spend.id,
    metadata: spend.metadata as MessageMetadata | null,
    model: spend.model ?? '',
    provider: spend.provider ?? '',
    spend: usage?.cost ?? metadata?.cost ?? 0,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    tps: performance?.tps ?? metadata?.tps ?? 0,
    ttft: performance?.ttft ?? metadata?.ttft ?? 0,
    type: 'chat',
    updatedAt: spend.createdAt,
    userDisplay: spend.userDisplay || spend.userId,
    userId: spend.userId,
  } satisfies GlobalUsageRecordItem;
};

export type GroupByDayDimRow = {
  day: string;
  model: string;
  provider: string;
  spend: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  userDisplay: string | null;
  userId: string;
};

export const asRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
};

/**
 * Cap day-level chart series: top-N users by tokens + `__other__`, and
 * model/provider cardinality. Never emits blank userId (GroupBy.User).
 */
export const capGroupByDayRecords = (
  day: string,
  rows: GroupByDayDimRow[],
): GlobalUsageRecordItem[] => {
  if (rows.length === 0) return [];

  // User totals for ranking.
  const userTotals = new Map<string, { display: string; tokens: number }>();
  for (const row of rows) {
    const uid = row.userId || GROUP_BY_DAY_OTHER_USER_ID;
    const prev = userTotals.get(uid);
    const tokens = row.totalInputTokens + row.totalOutputTokens;
    const display = (row.userDisplay || row.userId || GROUP_BY_DAY_OTHER_USER_ID).trim();
    if (prev) {
      prev.tokens += tokens;
    } else {
      userTotals.set(uid, { display, tokens });
    }
  }

  const rankedUsers = [...userTotals.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]),
  );
  const topUserIds = new Set(rankedUsers.slice(0, GROUP_BY_DAY_TOP_USERS).map(([id]) => id));

  // Model / provider global cardinality for the day (by token mass).
  const modelTokens = new Map<string, number>();
  const providerTokens = new Map<string, number>();
  for (const row of rows) {
    const tokens = row.totalInputTokens + row.totalOutputTokens;
    const model = row.model || '__other__';
    const provider = row.provider || '__other__';
    modelTokens.set(model, (modelTokens.get(model) ?? 0) + tokens);
    providerTokens.set(provider, (providerTokens.get(provider) ?? 0) + tokens);
  }
  const topModels = new Set(
    [...modelTokens.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, GROUP_BY_DAY_MAX_MODELS)
      .map(([id]) => id),
  );
  const topProviders = new Set(
    [...providerTokens.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, GROUP_BY_DAY_MAX_PROVIDERS)
      .map(([id]) => id),
  );

  // Merge into (userId, model, provider) buckets after caps.
  type Bucket = {
    model: string;
    provider: string;
    spend: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    userDisplay: string;
    userId: string;
  };
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    let userId = row.userId || GROUP_BY_DAY_OTHER_USER_ID;
    let userDisplay = (row.userDisplay || row.userId || 'Other').trim() || userId;
    if (!topUserIds.has(userId)) {
      userId = GROUP_BY_DAY_OTHER_USER_ID;
      userDisplay = 'Other';
    }

    let model = row.model || '';
    if (model && !topModels.has(model)) model = '__other__';
    let provider = row.provider || '';
    if (provider && !topProviders.has(provider)) provider = '__other__';

    const key = `${userId}\0${model}\0${provider}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.spend += row.spend;
      existing.totalInputTokens += row.totalInputTokens;
      existing.totalOutputTokens += row.totalOutputTokens;
    } else {
      buckets.set(key, {
        model,
        provider,
        spend: row.spend,
        totalInputTokens: row.totalInputTokens,
        totalOutputTokens: row.totalOutputTokens,
        userDisplay,
        userId,
      });
    }
  }

  const dayAt = dayjs.utc(day).startOf('day').toDate();
  return [...buckets.values()].map((b) => {
    const totalInputTokens = b.totalInputTokens;
    const totalOutputTokens = b.totalOutputTokens;
    return {
      createdAt: dayAt,
      id: `agg:${day}:${b.userId}:${b.model}:${b.provider}`,
      model: b.model,
      provider: b.provider,
      spend: b.spend,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      tps: 0,
      ttft: 0,
      type: 'chat' as const,
      updatedAt: dayAt,
      userDisplay: b.userDisplay,
      userId: b.userId,
    } satisfies GlobalUsageRecordItem;
  });
};

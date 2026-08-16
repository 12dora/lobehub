/**
 * Platform-wide (global) analytics aggregation — no ownership / workspace scope.
 *
 * Mirrors the business filters of MessageModel / TopicModel / AgentModel /
 * AgentOperationModel / UsageRecordService stats methods, without
 * `buildWorkspaceWhere`. Used only by admin.stats (platform_stats:read:all).
 */
import { INBOX_SESSION_ID } from '@lobechat/const';
import type { AgentRankItem, ModelRankItem, TopicRankItem } from '@lobechat/types';
import type { HeatmapsProps } from '@lobehub/charts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { SQL } from 'drizzle-orm';
import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { MessageMetadata } from '@/types/message';
import type { UsageLog, UsageRecordItem } from '@/types/usage/usageRecord';
import { today } from '@/utils/time';

import { agents, messages, topics, users } from '../../schemas';
import { agentOperations } from '../../schemas/agentOperations';
import type { LobeChatDatabase } from '../../type';
import { genEndDateWhere, genRangeWhere, genStartDateWhere, genWhere } from '../../utils/genWhere';
import { normalizeInboxAgentMeta } from '../../utils/inboxAgent';

dayjs.extend(utc);

/**
 * Parse a calendar day (`YYYY-MM-DD`) as UTC midnight.
 * Explicit UTC policy so half-open bounds do not shift with the process timezone (DB-008).
 */
const utcDayStart = (ymd: string): Date | null => {
  // Accept only date-shaped input; reject timestamps so callers stay calendar-day based.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const d = new Date(ymd);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(`${ymd}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const utcDayAfter = (ymd: string): Date | null => {
  const start = utcDayStart(ymd);
  if (!start) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Longest window an explicit `[startAt, endAt)` filter may span (admin stats DoS bound). */
export const MAX_STATS_RANGE_DAYS = 366;
/** Window used when only one explicit bound is supplied (defensive; clients send both). */
const DEFAULT_EXPLICIT_RANGE_DAYS = 30;

/** Invalid / oversized explicit window — routers map this to HTTP 400. */
export class StatsRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatsRangeError';
  }
}

/**
 * Unknown IANA time zone on an activity series request. Subclasses
 * {@link StatsRangeError} so the routers' single 400 mapping keeps covering it,
 * while still allowing a precise `stats_timezone_invalid` reason.
 */
export class StatsTimeZoneError extends StatsRangeError {
  constructor(message: string) {
    super(message);
    this.name = 'StatsTimeZoneError';
  }
}

/**
 * Filter accepted by every platform stats aggregate.
 * `startAt` / `endAt` are exact instants forming a half-open window `[startAt, endAt)`;
 * they win over `mo`. Legacy `YYYY-MM-DD` strings stay accepted as UTC calendar-day
 * bounds (`endAt` becomes the following midnight, i.e. the day stays inclusive).
 */
export interface StatsRangeParams {
  endAt?: Date | string;
  mo?: string;
  startAt?: Date | string;
}

export interface StatsFilterParams extends StatsRangeParams {
  /** Restrict the aggregate to a single platform user. */
  userId?: string;
}

/** Month-shaped call sites keep accepting the legacy bare `mo` string. */
export type StatsFilterArg = string | StatsFilterParams | undefined;

export interface ResolvedStatsRange {
  /** Exclusive upper bound. */
  endAt: Date;
  /** Inclusive lower bound. */
  startAt: Date;
}

export const toStatsFilterParams = (arg: StatsFilterArg): StatsFilterParams =>
  typeof arg === 'string' ? { mo: arg } : (arg ?? {});

/** Instant for a lower bound: calendar days resolve to UTC midnight. */
const toStartInstant = (value: Date | string): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  return utcDayStart(value);
};

/** Instant for an exclusive upper bound: a calendar day resolves to the next UTC midnight. */
const toEndInstantExclusive = (value: Date | string): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return utcDayAfter(value);
  return utcDayStart(value);
};

/**
 * Single seam that turns every accepted stats filter into a half-open instant window.
 * Explicit `startAt` / `endAt` win over `mo`; without either, the (current) month is used.
 */
export const resolveStatsRange = (arg?: StatsFilterArg): ResolvedStatsRange => {
  const params = toStatsFilterParams(arg);

  if (params.startAt !== undefined || params.endAt !== undefined) {
    const endAt = params.endAt === undefined ? new Date() : toEndInstantExclusive(params.endAt);
    if (!endAt) throw new StatsRangeError('Invalid endAt');

    const startAt =
      params.startAt === undefined
        ? new Date(endAt.getTime() - DEFAULT_EXPLICIT_RANGE_DAYS * DAY_MS)
        : toStartInstant(params.startAt);
    if (!startAt) throw new StatsRangeError('Invalid startAt');

    if (startAt.getTime() >= endAt.getTime())
      throw new StatsRangeError('startAt must be before endAt');
    if (endAt.getTime() - startAt.getTime() > MAX_STATS_RANGE_DAYS * DAY_MS)
      throw new StatsRangeError(`Range must not exceed ${MAX_STATS_RANGE_DAYS} days`);

    return { endAt, startAt };
  }

  const month =
    params.mo && dayjs.utc(params.mo, 'YYYY-MM', true).isValid()
      ? dayjs.utc(params.mo, 'YYYY-MM').startOf('month')
      : dayjs.utc().startOf('month');

  return { endAt: month.add(1, 'month').toDate(), startAt: month.toDate() };
};

/**
 * Half-open `[startAt, endAt)` predicate on a timestamp column (DB-008): the upper
 * bound is exclusive, so midnight of the following day never leaks into a range.
 */
export const genInstantRangeWhere = (range: ResolvedStatsRange, key: AnyPgColumn): SQL =>
  and(gte(key, range.startAt), lt(key, range.endAt))!;

/** UTC calendar days covered by a half-open window (upper bound exclusive). */
const eachUtcDayKey = ({ endAt, startAt }: ResolvedStatsRange): string[] => {
  const first = dayjs.utc(startAt).startOf('day');
  const last = dayjs.utc(new Date(endAt.getTime() - 1)).startOf('day');
  const keys: string[] = [];
  for (let date = first; !date.isAfter(last, 'day'); date = date.add(1, 'day')) {
    keys.push(date.format('YYYY-MM-DD'));
  }
  return keys;
};

/** Bucket width of an activity series. Mirrors the `date_trunc` unit used in SQL. */
export type ActivityGranularity = 'day' | 'hour' | 'week';
/** What an activity bucket counts: every message, or the assistant-gated token sum. */
export type ActivityMetric = 'messages' | 'tokens';

export interface ActivitySeriesParams extends StatsFilterParams {
  granularity?: ActivityGranularity;
  metric?: ActivityMetric;
  /** IANA zone the buckets are expressed in. Defaults to UTC. */
  timeZone?: string;
}

export interface ActivityPoint {
  /** `YYYY-MM-DDTHH:00` for hour buckets, `YYYY-MM-DD` for day / week (Monday) buckets. */
  bucket: string;
  count: number;
  /** 0..4 heatmap intensity. */
  level: number;
}

/** Below this span an activity series buckets by hour (today / last 24 hours). */
const HOURLY_ACTIVITY_SPAN_MS = 48 * 60 * 60 * 1000;
/**
 * Hard ceiling on the buckets one activity series may return. Derived granularity can
 * never reach it (366 daily buckets at most); an explicit `granularity: 'hour'` over a
 * long window can, and is rejected rather than silently coarsened.
 */
const MAX_ACTIVITY_BUCKETS = 2000;

/**
 * Canonical IANA zones plus `UTC`, which `Intl.supportedValuesOf` omits even though it
 * is the default here and a valid PostgreSQL zone. Matching is case-sensitive so the
 * value handed to `AT TIME ZONE` is always a zone both PostgreSQL and `Intl` agree on.
 */
let supportedTimeZones: Set<string> | undefined;
const resolveActivityTimeZone = (timeZone?: string): string => {
  if (!timeZone) return 'UTC';
  supportedTimeZones ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  if (!supportedTimeZones.has(timeZone)) throw new StatsTimeZoneError('Unknown IANA time zone');
  return timeZone;
};

const zonedHourFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Wall-clock hour of `at` in `timeZone`, carried as a UTC dayjs so bucket arithmetic
 * stays on the local calendar (a DST jump never shifts a day key).
 */
const zonedHour = (at: Date, timeZone: string) => {
  let formatter = zonedHourFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      month: '2-digit',
      timeZone,
      year: 'numeric',
    });
    zonedHourFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) parts[part.type] = part.value;
  return dayjs.utc(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00:00.000Z`);
};

/** Truncate a wall-clock hour to the bucket start; weeks start on Monday (date_trunc parity). */
const truncateToBucket = (at: dayjs.Dayjs, granularity: 'day' | 'week') => {
  const day = at.startOf('day');
  return granularity === 'day' ? day : day.subtract((day.day() + 6) % 7, 'day');
};

const formatBucketKey = (at: dayjs.Dayjs, granularity: ActivityGranularity) =>
  at.format(granularity === 'hour' ? 'YYYY-MM-DD[T]HH:00' : 'YYYY-MM-DD');

const tooManyBuckets = () =>
  new StatsRangeError(
    `Range yields more than ${MAX_ACTIVITY_BUCKETS} buckets; use a coarser granularity`,
  );

/**
 * Hour buckets by walking real instants, not wall-clock arithmetic: only hours that
 * actually exist in `timeZone` are emitted, so a spring-forward gap never yields a phantom
 * bucket and the two passes of a fall-back hour collapse into the single label PostgreSQL
 * groups them under. Sampled twice per hour because a few zones shift by 30 minutes
 * (Australia/Lord_Howe), which leaves a half-existing hour a whole-hour walk would skip.
 */
const eachHourKey = ({ endAt, startAt }: ResolvedStatsRange, timeZone: string): string[] => {
  const keys = new Set<string>();
  const add = (at: Date) => {
    keys.add(formatBucketKey(zonedHour(at, timeZone), 'hour'));
    if (keys.size > MAX_ACTIVITY_BUCKETS) throw tooManyBuckets();
  };

  const end = endAt.getTime();
  // Start on the UTC hour at or before `startAt`: in zones offset by :30 / :45 that instant
  // still belongs to the bucket holding `startAt`, never to an earlier one.
  for (let at = Math.floor(startAt.getTime() / HOUR_MS) * HOUR_MS; at < end; at += HOUR_MS / 2)
    add(new Date(at));
  // The final bucket may open after the last sampled UTC hour (again the :30 / :45 zones).
  add(new Date(end - 1));

  return [...keys];
};

/**
 * Day / week buckets. Calendar arithmetic on the zone's wall clock is DST-safe by
 * construction — a 23 or 25 hour day is still exactly one calendar date — as long as both
 * endpoints are derived from real instants, which they are.
 */
const eachCalendarKey = (
  { endAt, startAt }: ResolvedStatsRange,
  granularity: 'day' | 'week',
  timeZone: string,
): string[] => {
  const first = truncateToBucket(zonedHour(startAt, timeZone), granularity);
  const last = truncateToBucket(zonedHour(new Date(endAt.getTime() - 1), timeZone), granularity);
  const keys: string[] = [];
  for (let cursor = first; !cursor.isAfter(last); cursor = cursor.add(1, granularity)) {
    keys.push(formatBucketKey(cursor, granularity));
    if (keys.length > MAX_ACTIVITY_BUCKETS) throw tooManyBuckets();
  }
  return keys;
};

/** Every bucket a half-open window touches, expressed in `timeZone` (upper bound exclusive). */
const eachBucketKey = (
  range: ResolvedStatsRange,
  granularity: ActivityGranularity,
  timeZone: string,
): string[] =>
  granularity === 'hour'
    ? eachHourKey(range, timeZone)
    : eachCalendarKey(range, granularity, timeZone);

/**
 * Bucket width when the caller did not pin one — derived from the window span. Only `hour`
 * and `day` are ever derived: an explicit window may not span more than
 * {@link MAX_STATS_RANGE_DAYS} days, so a span wide enough to warrant weeks cannot reach
 * here. `week` stays reachable through an explicit `granularity: 'week'`.
 */
const deriveGranularity = ({ endAt, startAt }: ResolvedStatsRange): ActivityGranularity =>
  endAt.getTime() - startAt.getTime() < HOURLY_ACTIVITY_SPAN_MS ? 'hour' : 'day';

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
const explicitRangeWhere = (
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
const legacyDateWheres = (
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
const MAX_HEATMAP_LEVEL = 4;
const HEATMAP_MESSAGES_PER_LEVEL = 5;

/** The two heatmap formulas above, applied to one activity bucket. */
const activityLevel = (metric: ActivityMetric, value: number, maxValue: number): number => {
  if (value <= 0) return 0;
  if (metric === 'messages')
    return Math.min(MAX_HEATMAP_LEVEL, Math.ceil(value / HEATMAP_MESSAGES_PER_LEVEL));
  return maxValue > 0
    ? Math.min(MAX_HEATMAP_LEVEL, Math.max(1, Math.ceil((value / maxValue) * MAX_HEATMAP_LEVEL)))
    : 0;
};

const userDisplaySql = sql<string>`COALESCE(NULLIF(TRIM(${users.fullName}), ''), NULLIF(TRIM(${users.username}), ''), NULLIF(TRIM(${users.email}), ''), ${users.id})`;

type GroupByDayDimRow = {
  day: string;
  model: string;
  provider: string;
  spend: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  userDisplay: string | null;
  userId: string;
};

const asRows = <T>(result: unknown): T[] => {
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
const capGroupByDayRecords = (day: string, rows: GroupByDayDimRow[]): GlobalUsageRecordItem[] => {
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

export class PlatformGlobalStatsModel {
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  countUsers = async (params?: {
    activeDays?: number;
    endAt?: Date | string;
    startAt?: Date | string;
  }): Promise<{
    active: number;
    total: number;
  }> => {
    // Explicit window wins over `activeDays` (admin time-range filter).
    const windowWhere = explicitRangeWhere(params, users.lastActiveAt);
    const activeSince = dayjs()
      .subtract(params?.activeDays ?? 30, 'day')
      .toDate();

    const [totalRow] = await this.db.select({ count: count() }).from(users);
    const [activeRow] = await this.db
      .select({ count: count() })
      .from(users)
      .where(
        genWhere([
          isNotNull(users.lastActiveAt),
          windowWhere ?? gte(users.lastActiveAt, activeSince),
        ]),
      );

    return {
      active: activeRow?.count ?? 0,
      total: totalRow?.count ?? 0,
    };
  };

  countMessages = async (
    params?: CountDateParams & StatsFilterParams & { role?: string },
  ): Promise<number> => {
    const explicit = explicitRangeWhere(params, messages.createdAt);
    const result = await this.db
      .select({ count: count(messages.id) })
      .from(messages)
      .where(
        genWhere([
          params?.role ? eq(messages.role, params.role) : undefined,
          params?.userId ? eq(messages.userId, params.userId) : undefined,
          ...legacyDateWheres(explicit, params, messages.createdAt),
        ]),
      );

    return result[0]?.count ?? 0;
  };

  countTopics = async (params?: CountDateParams & StatsFilterParams): Promise<number> => {
    const explicit = explicitRangeWhere(params, topics.createdAt);
    const result = await this.db
      .select({ count: count(topics.id) })
      .from(topics)
      .where(
        genWhere([
          params?.userId ? eq(topics.userId, params.userId) : undefined,
          ...legacyDateWheres(explicit, params, topics.createdAt),
        ]),
      );

    return result[0]?.count ?? 0;
  };

  countAgents = async (params?: CountDateParams & StatsFilterParams): Promise<number> => {
    // Align with AgentModel.countAgents: non-virtual only (virtual=false OR virtual IS NULL).
    // Inbox (virtual=true) is intentionally excluded from countAgents; rankAgents uses
    // isNonVirtualAgentSql which additionally includes the inbox slug.
    const explicit = explicitRangeWhere(params, agents.createdAt);
    const result = await this.db
      .select({ count: count() })
      .from(agents)
      .where(
        genWhere([
          or(eq(agents.virtual, false), isNull(agents.virtual)),
          params?.userId ? eq(agents.userId, params.userId) : undefined,
          ...legacyDateWheres(explicit, params, agents.createdAt),
        ]),
      );

    return result[0]?.count ?? 0;
  };

  totals = async (params?: { activeDays?: number }): Promise<GlobalStatsTotals> => {
    const [usersCount, messagesCount, topicsCount, agentsCount] = await Promise.all([
      this.countUsers(params),
      this.countMessages(),
      this.countTopics(),
      this.countAgents(),
    ]);

    return {
      agents: agentsCount,
      messages: messagesCount,
      topics: topicsCount,
      usersActive: usersCount.active,
      usersTotal: usersCount.total,
    };
  };

  /**
   * User totals only — avoids the three lifetime table scans in {@link totals}
   * when the caller only needs usersActive / usersTotal (admin overview KPIs).
   */
  userTotals = async (params?: {
    activeDays?: number;
    endAt?: Date | string;
    startAt?: Date | string;
  }): Promise<Pick<GlobalStatsTotals, 'usersActive' | 'usersTotal'>> => {
    const usersCount = await this.countUsers(params);
    return {
      usersActive: usersCount.active,
      usersTotal: usersCount.total,
    };
  };

  /**
   * Bounded daily token series for the admin overview chart.
   * SQL `GROUP BY day` only — never materializes per-message or per-user rows.
   */
  findDailyTokenTotals = async (
    arg?: StatsFilterArg,
  ): Promise<Array<{ day: string; totalTokens: number }>> => {
    const params = toStatsFilterParams(arg);
    const range = resolveStatsRange(params);
    const inputTokensExpr = sql<number>`COALESCE(
      (${messages.usage}->>'totalInputTokens')::double precision,
      (${messages.metadata}->'usage'->>'totalInputTokens')::double precision,
      (${messages.metadata}->>'totalInputTokens')::double precision,
      0
    )`;
    const outputTokensExpr = sql<number>`COALESCE(
      (${messages.usage}->>'totalOutputTokens')::double precision,
      (${messages.metadata}->'usage'->>'totalOutputTokens')::double precision,
      (${messages.metadata}->>'totalOutputTokens')::double precision,
      0
    )`;
    const dayExpr = sql<string>`to_char(date_trunc('day', ${messages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

    const rangeWhere = genWhere([
      eq(messages.role, 'assistant'),
      genInstantRangeWhere(range, messages.createdAt),
      params.userId ? eq(messages.userId, params.userId) : undefined,
    ]);

    const dayTotals = await this.db
      .select({
        day: dayExpr.as('day'),
        totalTokens:
          sql<number>`COALESCE(SUM(${inputTokensExpr} + ${outputTokensExpr}), 0)`.mapWith(Number),
      })
      .from(messages)
      .where(rangeWhere)
      .groupBy(dayExpr)
      .orderBy(asc(dayExpr));

    const byDay = new Map(dayTotals.map((row) => [row.day, row.totalTokens]));
    return eachUtcDayKey(range).map((day) => ({ day, totalTokens: byDay.get(day) ?? 0 }));
  };

  /**
   * Range-aware activity series behind the admin 活跃度 card.
   *
   * One `GROUP BY date_trunc(<granularity>, created_at AT TIME ZONE <tz>)` pass, zero-filled
   * across the whole half-open window so the chart never shows a hole. Without an explicit
   * bound the last 30 days ending now are used — never a full-table scan. `metric: 'messages'`
   * counts every message (no role gate, same population as {@link getHeatmaps});
   * `metric: 'tokens'` sums the assistant-gated {@link messageTotalTokensSql}, the same
   * expression {@link getTokenHeatmaps} uses. `level` keeps the two heatmap formulas: absolute
   * for messages, relative to the busiest bucket of the returned set for tokens.
   *
   * A derived granularity is only ever `hour` (span < 48h) or `day`, because an explicit window
   * may not span more than {@link MAX_STATS_RANGE_DAYS} days; `week` requires asking for it.
   */
  findActivitySeries = async (params?: ActivitySeriesParams): Promise<ActivityPoint[]> => {
    const timeZone = resolveActivityTimeZone(params?.timeZone);
    const metric = params?.metric ?? 'tokens';
    // Always bounded: a missing endAt resolves to now and a missing startAt to endAt − 30d.
    const range = resolveStatsRange({
      endAt: params?.endAt ?? new Date(),
      startAt: params?.startAt,
    });
    const granularity = params?.granularity ?? deriveGranularity(range);
    const buckets = eachBucketKey(range, granularity, timeZone);

    // Zone and unit travel as bind parameters — never string-concatenated into SQL.
    const bucketExpr = sql<string>`to_char(
      date_trunc(${granularity}, ${messages.createdAt} AT TIME ZONE ${timeZone}),
      ${granularity === 'hour' ? 'YYYY-MM-DD"T"HH24":00"' : 'YYYY-MM-DD'}
    )`;
    const countExpr =
      metric === 'messages'
        ? sql<number>`COUNT(${messages.id})`
        : sql<number>`COALESCE(SUM(${messageTotalTokensSql()}), 0)`;

    const rows = await this.db
      .select({ bucket: bucketExpr.as('bucket'), count: countExpr.mapWith(Number) })
      .from(messages)
      .where(
        genWhere([
          // Usage only ever lives on assistant replies; message counts cover every role.
          metric === 'tokens' ? eq(messages.role, 'assistant') : undefined,
          genInstantRangeWhere(range, messages.createdAt),
          params?.userId ? eq(messages.userId, params.userId) : undefined,
        ]),
      )
      // Group by the projected column: repeating the expression would re-bind the zone /
      // unit parameters, and PostgreSQL never matches two distinct placeholders.
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const byBucket = new Map(rows.map((row) => [row.bucket, row.count]));
    const maxCount = rows.reduce((max, row) => Math.max(max, row.count), 0);

    return buckets.map((bucket) => {
      const value = byBucket.get(bucket) ?? 0;
      return { bucket, count: value, level: activityLevel(metric, value, maxCount) };
    });
  };

  /** Ranks the messages themselves — window and user filter apply to `messages`. */
  rankModels = async (
    limit: number = 10,
    options?: StatsFilterParams,
  ): Promise<ModelRankItem[]> => {
    return this.db
      .select({
        count: count(messages.id).as('count'),
        id: messages.model,
      })
      .from(messages)
      .where(
        genWhere([
          isNotNull(messages.model),
          explicitRangeWhere(options, messages.createdAt),
          options?.userId ? eq(messages.userId, options.userId) : undefined,
        ]),
      )
      .having(({ count: c }) => gt(c, 0))
      .groupBy(messages.model)
      .orderBy(desc(sql`count`), asc(messages.model))
      .limit(limit) as Promise<ModelRankItem[]>;
  };

  /**
   * Ranks assistants by the topics opened on them. The window / user filter applies to
   * the counted rows (topics), so an assistant only ranks for what happened in-window.
   */
  rankAgents = async (
    limit: number = 10,
    options?: StatsFilterParams,
  ): Promise<AgentRankItem[]> => {
    const joinWhere = genWhere([
      eq(topics.agentId, agents.id),
      explicitRangeWhere(options, topics.createdAt),
      options?.userId ? eq(topics.userId, options.userId) : undefined,
    ]);

    const rows = await this.db
      .select({
        avatar: agents.avatar,
        backgroundColor: agents.backgroundColor,
        count: count(topics.id).as('count'),
        id: agents.id,
        slug: agents.slug,
        title: agents.title,
      })
      .from(agents)
      .leftJoin(topics, joinWhere)
      // Same legacy population as countAgents (virtual=false OR NULL) + inbox (DB-009).
      .where(isNonVirtualAgentSql())
      .groupBy(agents.id)
      .having(({ count: c }) => gt(c, 0))
      .orderBy(desc(sql`count`))
      .limit(limit);

    return rows.map(({ slug, ...row }) => normalizeInboxAgentMeta(row, { slug }));
  };

  /** Ranks topics by in-window message volume; the user filter scopes topic ownership. */
  rankTopics = async (
    limit: number = 10,
    options?: StatsFilterParams,
  ): Promise<TopicRankItem[]> => {
    const joinWhere = genWhere([
      eq(topics.id, messages.topicId),
      explicitRangeWhere(options, messages.createdAt),
    ]);

    return this.db
      .select({
        agentId: topics.agentId,
        count: count(messages.id).as('count'),
        id: topics.id,
        title: topics.title,
      })
      .from(topics)
      .leftJoin(messages, joinWhere)
      .where(genWhere([options?.userId ? eq(topics.userId, options.userId) : undefined]))
      .groupBy(topics.id)
      .orderBy(desc(sql`count`))
      .having(({ count: c }) => gt(c, 0))
      .limit(limit);
  };

  /**
   * Users ranked by token usage in the window (admin 用户排行).
   *
   * `messages` counts every message the user wrote in the window (same population as
   * {@link countMessages}); tokens / cost are summed over assistant rows only — the same
   * role gate the other usage aggregates use, so stray usage payloads on a user row can
   * never inflate a ranking. Never emits the raw email as a separate field — the display
   * name is the same COALESCE chain used by the usage endpoints.
   *
   * Without an explicit window the last {@link DEFAULT_EXPLICIT_RANGE_DAYS} days ending
   * now are used: this endpoint never scans the whole `messages` table.
   *
   * `orderBy` sorts in SQL (DESC, tie-break `userId` ASC) so `limit` really is the top-N
   * for that metric — a client must not re-sort a token-ordered page.
   */
  rankUsers = async (params?: {
    endAt?: Date | string;
    limit?: number;
    orderBy?: UserRankOrderBy;
    startAt?: Date | string;
    userId?: string;
  }): Promise<UserRankItem[]> => {
    const limit = Math.min(Math.max(Math.floor(params?.limit ?? 10), 1), 100);
    // Always bounded: a missing endAt resolves to now and a missing startAt to endAt − 30d.
    const range = resolveStatsRange({
      endAt: params?.endAt ?? new Date(),
      startAt: params?.startAt,
    });
    const costExpr = sql<number>`COALESCE(
      (${messages.usage}->>'cost')::double precision,
      (${messages.metadata}->'usage'->>'cost')::double precision,
      (${messages.metadata}->>'cost')::double precision,
      0
    )`;
    const inputTokensExpr = sql<number>`COALESCE(
      (${messages.usage}->>'totalInputTokens')::double precision,
      (${messages.metadata}->'usage'->>'totalInputTokens')::double precision,
      (${messages.metadata}->>'totalInputTokens')::double precision,
      0
    )`;
    const outputTokensExpr = sql<number>`COALESCE(
      (${messages.usage}->>'totalOutputTokens')::double precision,
      (${messages.metadata}->'usage'->>'totalOutputTokens')::double precision,
      (${messages.metadata}->>'totalOutputTokens')::double precision,
      0
    )`;
    // users row may be missing (deleted account) — fall back to the message's userId.
    const nameExpr = sql<string>`COALESCE(NULLIF(TRIM(${users.fullName}), ''), NULLIF(TRIM(${users.username}), ''), NULLIF(TRIM(${users.email}), ''), ${users.id}, ${messages.userId})`;
    /** Usage lives on assistant replies — gate every SUM, never the message COUNT. */
    const assistantOnly = sql`FILTER (WHERE ${messages.role} = 'assistant')`;
    const costSumExpr = sql<number>`COALESCE(SUM(${costExpr}) ${assistantOnly}, 0)`;
    const inputSumExpr = sql<number>`COALESCE(SUM(${inputTokensExpr}) ${assistantOnly}, 0)`;
    const outputSumExpr = sql<number>`COALESCE(SUM(${outputTokensExpr}) ${assistantOnly}, 0)`;
    const totalTokensExpr = sql<number>`COALESCE(SUM(${inputTokensExpr} + ${outputTokensExpr}) ${assistantOnly}, 0)`;
    const messagesCountExpr = count(messages.id);
    const orderByExpr = {
      cost: costSumExpr,
      messages: messagesCountExpr,
      totalTokens: totalTokensExpr,
    }[params?.orderBy ?? 'totalTokens'];

    const rows = await this.db
      .select({
        avatar: users.avatar,
        cost: costSumExpr.mapWith(Number),
        inputTokens: inputSumExpr.mapWith(Number),
        messages: messagesCountExpr.mapWith(Number),
        name: nameExpr,
        outputTokens: outputSumExpr.mapWith(Number),
        totalTokens: totalTokensExpr.mapWith(Number),
        userId: messages.userId,
      })
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(
        genWhere([
          genInstantRangeWhere(range, messages.createdAt),
          params?.userId ? eq(messages.userId, params.userId) : undefined,
        ]),
      )
      .groupBy(messages.userId, nameExpr, users.avatar)
      .orderBy(desc(orderByExpr), asc(messages.userId))
      .limit(limit);

    return rows.map((row) => ({
      avatar: row.avatar ?? null,
      cost: row.cost ?? 0,
      inputTokens: Math.round(row.inputTokens ?? 0),
      messages: row.messages ?? 0,
      name: row.name || row.userId,
      outputTokens: Math.round(row.outputTokens ?? 0),
      totalTokens: Math.round(row.totalTokens ?? 0),
      userId: row.userId,
    }));
  };

  getHeatmaps = async (): Promise<HeatmapsProps['data']> => {
    const startDate = today().subtract(1, 'year').startOf('day');
    const endDate = today().endOf('day');

    const result = await this.db
      .select({
        count: count(messages.id),
        date: sql`DATE(${messages.createdAt})`.as('heatmaps_date'),
      })
      .from(messages)
      .where(
        genWhere([
          genRangeWhere(
            [startDate.format('YYYY-MM-DD'), endDate.add(1, 'day').format('YYYY-MM-DD')],
            messages.createdAt,
            (date) => date.toDate(),
          ),
        ]),
      )
      .groupBy(sql`heatmaps_date`)
      .orderBy(desc(sql`heatmaps_date`));

    const heatmapData: HeatmapsProps['data'] = [];
    let currentDate = startDate.clone();

    const dateCountMap = new Map<string, number>();
    for (const item of result) {
      if (item?.date) {
        const dateStr = dayjs(item.date as string).format('YYYY-MM-DD');
        dateCountMap.set(dateStr, item.count);
      }
    }

    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, 'day')) {
      const formattedDate = currentDate.format('YYYY-MM-DD');
      const dayCount = dateCountMap.get(formattedDate) || 0;

      const levelCount = dayCount > 0 ? Math.ceil(dayCount / HEATMAP_MESSAGES_PER_LEVEL) : 0;
      const level = Math.min(MAX_HEATMAP_LEVEL, levelCount);

      heatmapData.push({
        count: dayCount,
        date: formattedDate,
        level,
      });

      currentDate = currentDate.add(1, 'day');
    }

    return heatmapData;
  };

  getTokenHeatmaps = async (): Promise<HeatmapsProps['data']> => {
    const startDate = today().subtract(1, 'year').startOf('day');
    const endDate = today().endOf('day');

    const result = await this.db
      .select({
        date: sql`DATE(${messages.createdAt})`.as('heatmaps_date'),
        tokens: sql<number>`COALESCE(SUM(${messageTotalTokensSql()}), 0)`.mapWith(Number),
      })
      .from(messages)
      .where(
        genWhere([
          eq(messages.role, 'assistant'),
          genRangeWhere(
            [startDate.format('YYYY-MM-DD'), endDate.add(1, 'day').format('YYYY-MM-DD')],
            messages.createdAt,
            (date) => date.toDate(),
          ),
        ]),
      )
      .groupBy(sql`heatmaps_date`)
      .orderBy(desc(sql`heatmaps_date`));

    const dateTokenMap = new Map<string, number>();
    let maxTokens = 0;
    for (const item of result) {
      if (item?.date) {
        const dateStr = dayjs(item.date as string).format('YYYY-MM-DD');
        const tokens = item.tokens || 0;
        dateTokenMap.set(dateStr, tokens);
        if (tokens > maxTokens) maxTokens = tokens;
      }
    }

    const heatmapData: HeatmapsProps['data'] = [];
    let currentDate = startDate.clone();

    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, 'day')) {
      const formattedDate = currentDate.format('YYYY-MM-DD');
      const tokens = dateTokenMap.get(formattedDate) || 0;

      const level =
        tokens > 0 && maxTokens > 0
          ? Math.min(
              MAX_HEATMAP_LEVEL,
              Math.max(1, Math.ceil((tokens / maxTokens) * MAX_HEATMAP_LEVEL)),
            )
          : 0;

      heatmapData.push({
        count: tokens,
        date: formattedDate,
        level,
      });

      currentDate = currentDate.add(1, 'day');
    }

    return heatmapData;
  };

  /**
   * Longest completed agent task, in seconds. An explicit `[startAt, endAt)` window (and
   * optional `userId`) narrows it to the admin filter; without one the trailing year is
   * kept, so the personal / unfiltered call sites are unchanged.
   */
  getMaxTaskDuration = async (params?: StatsFilterParams): Promise<number> => {
    const explicit = explicitRangeWhere(params, agentOperations.createdAt);
    const startDate = today().subtract(1, 'year').startOf('day').toDate();

    const [row] = await this.db
      .select({
        seconds:
          sql<number>`COALESCE(MAX(EXTRACT(EPOCH FROM (${agentOperations.completedAt} - ${agentOperations.startedAt}))), 0)`.mapWith(
            Number,
          ),
      })
      .from(agentOperations)
      .where(
        genWhere([
          isNotNull(agentOperations.startedAt),
          isNotNull(agentOperations.completedAt),
          params?.userId ? eq(agentOperations.userId, params.userId) : undefined,
          explicit ?? gte(agentOperations.createdAt, startDate),
        ]),
      );

    return row?.seconds ?? 0;
  };

  /**
   * Explicit page size for detail usage rows. Chart aggregation never materializes
   * this set — use {@link findAndGroupByDay}. Prefer paging via
   * {@link findByDateRangePage} / {@link findByMonthPage}; uncapped drain is
   * hard-capped at {@link MAX_USAGE_DETAIL_ROWS} to avoid OOM.
   */
  static readonly USAGE_PAGE_DEFAULT = 100;
  static readonly USAGE_PAGE_MAX = 500;

  /**
   * Keyset-paginated usage detail for a date range (inclusive calendar days).
   * Does not return a truncated full-month array — use `nextCursor` to continue.
   */
  findByDateRangePage = async (
    startAt: Date | string,
    endAt: Date | string,
    options?: { cursor?: string; limit?: number; userId?: string },
  ): Promise<{ items: GlobalUsageRecordItem[]; nextCursor: string | null }> => {
    const limit = Math.min(
      Math.max(Math.floor(options?.limit ?? PlatformGlobalStatsModel.USAGE_PAGE_DEFAULT), 1),
      PlatformGlobalStatsModel.USAGE_PAGE_MAX,
    );

    const conditions = genWhere([
      eq(messages.role, 'assistant'),
      genInstantRangeWhere(resolveStatsRange({ endAt, startAt }), messages.createdAt),
      options?.userId ? eq(messages.userId, options.userId) : undefined,
    ]);

    const cursor = options?.cursor;
    let cursorCondition: ReturnType<typeof and> | undefined;
    if (cursor?.includes('|')) {
      const [iso, id] = cursor.split('|');
      const at = new Date(iso);
      if (!Number.isNaN(at.getTime()) && id) {
        cursorCondition = or(
          lt(messages.createdAt, at),
          and(eq(messages.createdAt, at), lt(messages.id, id)),
        )!;
      }
    }

    const spends = await this.db
      .select({
        createdAt: messages.createdAt,
        id: messages.id,
        metadata: messages.metadata,
        model: messages.model,
        provider: messages.provider,
        role: messages.role,
        usage: messages.usage,
        userDisplay: userDisplaySql,
        userId: messages.userId,
      })
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(cursorCondition ? and(conditions, cursorCondition) : conditions)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = spends.length > limit;
    const page = hasMore ? spends.slice(0, limit) : spends;
    const items = page.map((spend) => {
      const metadata = spend.metadata as MessageMetadata | null;
      // Prefer the dedicated `usage` column, then nested metadata.usage /
      // metadata.performance, then deprecated flat metadata fields (parity with
      // UsageRecordService.findByDateRange).
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
    });

    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  };

  /**
   * Date-range usage detail. When `limit` is set, returns a single page (use
   * {@link findByDateRangePage} for cursors). When omitted, drains keyset pages
   * up to {@link MAX_USAGE_DETAIL_ROWS} (hard safety cap against OOM).
   */
  findByDateRange = async (
    startAt: Date | string,
    endAt: Date | string,
    options?: { limit?: number; userId?: string },
  ): Promise<GlobalUsageRecordItem[]> => {
    if (options?.limit !== undefined) {
      const { items } = await this.findByDateRangePage(startAt, endAt, options);
      return items;
    }

    const items: GlobalUsageRecordItem[] = [];
    let cursor: string | undefined;
    for (;;) {
      const remaining = MAX_USAGE_DETAIL_ROWS - items.length;
      if (remaining <= 0) break;

      const page = await this.findByDateRangePage(startAt, endAt, {
        cursor,
        limit: Math.min(PlatformGlobalStatsModel.USAGE_PAGE_MAX, remaining),
        userId: options?.userId,
      });
      items.push(...page.items);
      if (!page.nextCursor || items.length >= MAX_USAGE_DETAIL_ROWS) break;
      cursor = page.nextCursor;
    }
    return items.length > MAX_USAGE_DETAIL_ROWS ? items.slice(0, MAX_USAGE_DETAIL_ROWS) : items;
  };

  /**
   * Explicitly paginated monthly usage detail (bounded page size; never silent full-month cap).
   */
  findByMonthPage = async (
    arg?: StatsFilterArg,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ items: GlobalUsageRecordItem[]; nextCursor: string | null }> => {
    const params = toStatsFilterParams(arg);
    const { endAt, startAt } = resolveStatsRange(params);
    return this.findByDateRangePage(startAt, endAt, { ...options, userId: params.userId });
  };

  /**
   * Single-query full-month usage detail with a hard row ceiling (routers/F4).
   * Fetches `maxRows + 1` rows; when more remain, returns `hasMore: true` so the
   * router can fail closed with `usage_month_truncated` without 200 serial pages.
   */
  findByMonthBounded = async (
    arg: StatsFilterArg,
    maxRows: number,
  ): Promise<{ hasMore: boolean; items: GlobalUsageRecordItem[] }> => {
    const limit = Math.max(1, Math.floor(maxRows));
    // One range query with LIMIT maxRows+1 — same projection as keyset pages.
    const params = toStatsFilterParams(arg);
    const conditions = genWhere([
      eq(messages.role, 'assistant'),
      genInstantRangeWhere(resolveStatsRange(params), messages.createdAt),
      params.userId ? eq(messages.userId, params.userId) : undefined,
    ]);

    const spends = await this.db
      .select({
        createdAt: messages.createdAt,
        id: messages.id,
        metadata: messages.metadata,
        model: messages.model,
        provider: messages.provider,
        role: messages.role,
        usage: messages.usage,
        userDisplay: userDisplaySql,
        userId: messages.userId,
      })
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(conditions)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = spends.length > limit;
    const page = hasMore ? spends.slice(0, limit) : spends;
    const items = page.map((spend) => {
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
    });

    return { hasMore, items };
  };

  /**
   * Monthly usage detail. When `limit` is set, returns a single page; otherwise
   * drains via {@link findByDateRange} (hard-capped at {@link MAX_USAGE_DETAIL_ROWS}).
   */
  findByMonth = async (
    arg?: StatsFilterArg,
    options?: { limit?: number },
  ): Promise<GlobalUsageRecordItem[]> => {
    if (options?.limit !== undefined) {
      const { items } = await this.findByMonthPage(arg, options);
      return items;
    }

    const params = toStatsFilterParams(arg);
    const { endAt, startAt } = resolveStatsRange(params);
    return this.findByDateRange(startAt, endAt, { userId: params.userId });
  };

  /**
   * Daily chart aggregates computed in SQL. Never materializes unbounded raw
   * message rows. Populates `records` with **capped per-day dimension aggregates**:
   * top-N users by tokens + an aggregated `__other__` user bucket, with model and
   * provider cardinality caps (platform-instance/F6). GroupBy.User always gets
   * non-blank userId/displayName series.
   */
  findAndGroupByDay = async (arg?: StatsFilterArg): Promise<GlobalUsageLog[]> => {
    const params = toStatsFilterParams(arg);
    const range = resolveStatsRange(params);

    // Cost / token extraction mirrors findByDateRange fallback chain in SQL.
    const costExpr = sql<number>`COALESCE(
      (${messages.usage}->>'cost')::double precision,
      (${messages.metadata}->'usage'->>'cost')::double precision,
      (${messages.metadata}->>'cost')::double precision,
      0
    )`;
    const inputTokensExpr = sql<number>`COALESCE(
      (${messages.usage}->>'totalInputTokens')::double precision,
      (${messages.metadata}->'usage'->>'totalInputTokens')::double precision,
      (${messages.metadata}->>'totalInputTokens')::double precision,
      0
    )`;
    const outputTokensExpr = sql<number>`COALESCE(
      (${messages.usage}->>'totalOutputTokens')::double precision,
      (${messages.metadata}->'usage'->>'totalOutputTokens')::double precision,
      (${messages.metadata}->>'totalOutputTokens')::double precision,
      0
    )`;
    const dayExpr = sql<string>`to_char(date_trunc('day', ${messages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
    const modelExpr = sql<string>`COALESCE(${messages.model}, '')`;
    const providerExpr = sql<string>`COALESCE(${messages.provider}, '')`;

    const rangeWhere = genWhere([
      eq(messages.role, 'assistant'),
      genInstantRangeWhere(range, messages.createdAt),
      params.userId ? eq(messages.userId, params.userId) : undefined,
    ]);

    const [dayTotals, dimResult] = await Promise.all([
      this.db
        .select({
          day: dayExpr.as('day'),
          totalRequests: count(messages.id).mapWith(Number),
          totalSpend: sql<number>`COALESCE(SUM(${costExpr}), 0)`.mapWith(Number),
          totalTokens:
            sql<number>`COALESCE(SUM(${inputTokensExpr} + ${outputTokensExpr}), 0)`.mapWith(Number),
        })
        .from(messages)
        .where(rangeWhere)
        .groupBy(dayExpr)
        .orderBy(asc(dayExpr)),
      // Rank and fold every dimension before rows cross the DB boundary. The
      // second aggregation gives the result a hard day × capped-dimension bound.
      this.db.execute(sql`
        WITH base AS (
          SELECT
            ${dayExpr} AS day,
            COALESCE(${messages.userId}, ${GROUP_BY_DAY_OTHER_USER_ID}) AS user_id,
            ${userDisplaySql} AS user_display,
            ${modelExpr} AS model,
            ${providerExpr} AS provider,
            COALESCE(SUM(${costExpr}), 0)::double precision AS spend,
            COALESCE(SUM(${inputTokensExpr}), 0)::double precision AS input_tokens,
            COALESCE(SUM(${outputTokensExpr}), 0)::double precision AS output_tokens
          FROM ${messages}
          LEFT JOIN ${users} ON ${messages.userId} = ${users.id}
          WHERE ${rangeWhere}
          GROUP BY ${dayExpr}, ${messages.userId}, ${userDisplaySql}, ${modelExpr}, ${providerExpr}
        ),
        user_ranked AS (
          SELECT
            day,
            user_id,
            ROW_NUMBER() OVER (
              PARTITION BY day
              ORDER BY SUM(input_tokens + output_tokens) DESC, user_id ASC
            ) AS rank
          FROM base
          GROUP BY day, user_id
        ),
        model_ranked AS (
          SELECT
            day,
            model,
            ROW_NUMBER() OVER (
              PARTITION BY day
              ORDER BY SUM(input_tokens + output_tokens) DESC, model ASC
            ) AS rank
          FROM base
          GROUP BY day, model
        ),
        provider_ranked AS (
          SELECT
            day,
            provider,
            ROW_NUMBER() OVER (
              PARTITION BY day
              ORDER BY SUM(input_tokens + output_tokens) DESC, provider ASC
            ) AS rank
          FROM base
          GROUP BY day, provider
        ),
        labeled AS (
          SELECT
            base.day,
            CASE
              WHEN user_ranked.rank <= ${GROUP_BY_DAY_TOP_USERS} THEN base.user_id
              ELSE ${GROUP_BY_DAY_OTHER_USER_ID}
            END AS user_id,
            CASE
              WHEN user_ranked.rank <= ${GROUP_BY_DAY_TOP_USERS}
                THEN COALESCE(NULLIF(TRIM(base.user_display), ''), base.user_id)
              ELSE 'Other'
            END AS user_display,
            CASE
              WHEN base.model = '' OR model_ranked.rank <= ${GROUP_BY_DAY_MAX_MODELS}
                THEN base.model
              ELSE '__other__'
            END AS model,
            CASE
              WHEN base.provider = '' OR provider_ranked.rank <= ${GROUP_BY_DAY_MAX_PROVIDERS}
                THEN base.provider
              ELSE '__other__'
            END AS provider,
            base.spend,
            base.input_tokens,
            base.output_tokens
          FROM base
          INNER JOIN user_ranked
            ON base.day = user_ranked.day AND base.user_id = user_ranked.user_id
          INNER JOIN model_ranked
            ON base.day = model_ranked.day AND base.model = model_ranked.model
          INNER JOIN provider_ranked
            ON base.day = provider_ranked.day AND base.provider = provider_ranked.provider
        )
        SELECT
          day,
          model,
          provider,
          SUM(spend)::double precision AS spend,
          SUM(input_tokens)::double precision AS "totalInputTokens",
          SUM(output_tokens)::double precision AS "totalOutputTokens",
          MAX(user_display) AS "userDisplay",
          user_id AS "userId"
        FROM labeled
        GROUP BY day, user_id, model, provider
        ORDER BY day, user_id, model, provider
      `),
    ]);
    const dimRows = asRows<GroupByDayDimRow>(dimResult);

    type DimRow = (typeof dimRows)[number];
    const rowsByDay = new Map<string, DimRow[]>();
    for (const row of dimRows) {
      const list = rowsByDay.get(row.day) ?? [];
      list.push(row);
      rowsByDay.set(row.day, list);
    }

    const recordsByDay = new Map<string, GlobalUsageRecordItem[]>();
    for (const [day, rows] of rowsByDay) {
      recordsByDay.set(day, capGroupByDayRecords(day, rows));
    }

    const byDay = new Map(
      dayTotals.map((row) => [
        row.day,
        {
          date: dayjs.utc(row.day).toDate().getTime(),
          day: row.day,
          records: recordsByDay.get(row.day) ?? [],
          totalRequests: row.totalRequests,
          totalSpend: row.totalSpend,
          totalTokens: row.totalTokens,
        } satisfies GlobalUsageLog,
      ]),
    );

    // Every UTC day the half-open window touches, last day inclusive.
    return eachUtcDayKey(range).map(
      (key) =>
        byDay.get(key) ?? {
          date: dayjs.utc(key).toDate().getTime(),
          day: key,
          records: [],
          totalRequests: 0,
          totalSpend: 0,
          totalTokens: 0,
        },
    );
  };
}

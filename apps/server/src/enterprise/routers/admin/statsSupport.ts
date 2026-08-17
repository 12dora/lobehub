/**
 * Shared zod contracts and redaction helpers for admin.stats.
 *
 * Usage endpoints never return raw message metadata (tool snapshots, local files,
 * arguments/results). Full redacted month results are returned so daily analytics
 * that aggregate `records` stay accurate; SQL-level bounds live in globalStats.
 */
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  type GlobalUsageLog,
  type GlobalUsageRecordItem,
  PlatformGlobalStatsModel,
  type StatsFilterArg,
  StatsRangeError,
  StatsTimeZoneError,
} from '@/database/models/platform/globalStats';

import { userIdSchema } from '../../contracts/adminAudit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';

dayjs.extend(customParseFormat);

/** Safety bound for full-month usage drain (pages × USAGE_PAGE_MAX). */
const USAGE_FULL_MONTH_MAX_PAGES = 200;
/** Max rows for the single-query bounded path (same ceiling as 200 × 500). */
const USAGE_FULL_MONTH_MAX_ROWS =
  USAGE_FULL_MONTH_MAX_PAGES * PlatformGlobalStatsModel.USAGE_PAGE_MAX;

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => dayjs(value, 'YYYY-MM-DD', true).isValid(), 'Invalid calendar date');

const monthString = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM')
  .refine((value) => dayjs(value, 'YYYY-MM', true).isValid(), 'Invalid calendar month');

/**
 * Shared admin time-range filter (C7): ISO-8601 instants with offset/Z forming the
 * half-open window `[startAt, endAt)`. Explicit instants win over the legacy
 * calendar-day fields (`startDate` / `endDate` / `range`) and over `mo`.
 * Inputs stay non-strict on purpose so a client may pass the union of all filter
 * fields to any procedure; unknown keys are stripped rather than rejected.
 */
export const rangeShape = {
  endAt: z.string().datetime({ offset: true }).optional(),
  startAt: z.string().datetime({ offset: true }).optional(),
};

/** Longest window an explicit range may span — mirrors MAX_STATS_RANGE_DAYS. */
const MAX_RANGE_DAYS = 366;

type RangeShapeValue = { endAt?: string; startAt?: string };

export const refineRange = (value: RangeShapeValue | undefined, ctx: z.RefinementCtx) => {
  if (!value?.startAt || !value?.endAt) return;
  const startAt = new Date(value.startAt).getTime();
  const endAt = new Date(value.endAt).getTime();
  if (!(startAt < endAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'startAt must be before endAt',
      path: ['startAt'],
    });
    return;
  }
  if (endAt - startAt > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `range must not exceed ${MAX_RANGE_DAYS} days`,
      path: ['startAt'],
    });
  }
};

/** The shared C7 contract shape; every filtered procedure extends it. */
export const statsRangeInput = z.object({
  ...rangeShape,
  // Same bound as the rest of the admin surface (audit / users contracts).
  userId: userIdSchema.optional(),
});

export const monthInput = statsRangeInput
  .extend({ mo: monthString.optional() })
  .optional()
  .superRefine(refineRange);

export const rankInput = statsRangeInput
  .extend({ limit: z.number().int().min(1).max(100).optional() })
  .optional()
  .superRefine(refineRange);

export const rankUsersInput = statsRangeInput
  .extend({
    limit: z.number().int().min(1).max(100).optional(),
    orderBy: z.enum(['cost', 'messages', 'totalTokens']).default('totalTokens'),
  })
  .optional()
  .superRefine(refineRange)
  .describe(
    'Users ranked by usage. `startAt`/`endAt` form the half-open window; when both are ' +
      'omitted the server falls back to the last 30 days ending now (never a full-table scan). ' +
      '`limit` defaults to 10, `userId` narrows the ranking to a single user. `orderBy` picks ' +
      'the sort metric (DESC, tie-break userId ASC) and is applied in SQL, so the result is the ' +
      'true top-N for that metric — never re-sort a page client-side.',
  );

/**
 * Range-aware activity series (admin 活跃度 card). Everything is optional: without a
 * window the server falls back to the last 30 days, without a `granularity` it derives one
 * from the span (`< 48h` → hour, otherwise day — never week, since an explicit window may not
 * span more than `MAX_RANGE_DAYS`), and without a `metric` it sums tokens. `week` buckets
 * therefore only exist when the caller asks for them. `timeZone` is an IANA zone (default
 * `UTC`) validated against `Intl.supportedValuesOf('timeZone')`; an unknown zone reaches the
 * model and fails with HTTP 400 / `stats_timezone_invalid`, as does an hourly window past the
 * bucket ceiling. A reversed or oversized window is rejected one layer earlier, by the zod
 * refinement below, so it yields a plain `BAD_REQUEST` without the enterprise
 * `stats_range_invalid` payload — the same shape every other admin.stats procedure returns.
 */
export const activitySeriesInput = statsRangeInput
  .extend({
    granularity: z.enum(['day', 'hour', 'week']).optional(),
    metric: z.enum(['messages', 'tokens']).optional(),
    timeZone: z.string().min(1).max(64).optional(),
  })
  .optional()
  .superRefine(refineRange);

export const activitySeriesOutput = z.array(
  z
    .object({
      /** `YYYY-MM-DDTHH:00` for hour buckets, `YYYY-MM-DD` for day / week (Monday). */
      bucket: z.string(),
      count: z.number(),
      level: z.number().int().min(0).max(4),
    })
    .strict(),
);

export const countDateInput = statsRangeInput
  .extend({
    endDate: isoDateString.optional(),
    range: z.tuple([isoDateString, isoDateString]).optional(),
    startDate: isoDateString.optional(),
  })
  .optional()
  .superRefine((value, ctx) => {
    if (!value) return;
    refineRange(value, ctx);
    if (value.range && value.range[0] > value.range[1]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'range start must be on or before end',
        path: ['range'],
      });
    }
    if (value.startDate && value.endDate && value.startDate > value.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startDate must be on or before endDate',
        path: ['startDate'],
      });
    }
  });

export const userRankOutput = z.array(
  z
    .object({
      avatar: z.string().nullable(),
      cost: z.number(),
      inputTokens: z.number().int(),
      messages: z.number().int(),
      name: z.string(),
      outputTokens: z.number().int(),
      totalTokens: z.number().int(),
      userId: z.string(),
    })
    .strict(),
);

/**
 * Map an invalid / oversized window from the model layer to HTTP 400. An unknown IANA
 * zone on `activitySeries` takes the same path with the sibling reason
 * `stats_timezone_invalid`, so a client can tell the two apart.
 */
export const withRangeErrors = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StatsRangeError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        details: {
          reason:
            error instanceof StatsTimeZoneError ? 'stats_timezone_invalid' : 'stats_range_invalid',
        },
        httpCode: 'BAD_REQUEST',
        message: error.message,
      });
    }
    throw error;
  }
};

/** Whitelist projection for usage rows — excludes raw metadata / tool snapshots. */
export const usageRecordOutputSchema = z.object({
  createdAt: z.coerce.date(),
  id: z.string(),
  /** Always null — never emit local-file / tool-result snapshots. */
  metadata: z.null(),
  model: z.string(),
  provider: z.string(),
  spend: z.number(),
  totalInputTokens: z.number().nullable().optional(),
  totalOutputTokens: z.number().nullable().optional(),
  totalTokens: z.number().nullable().optional(),
  tps: z.number().nullable().optional(),
  ttft: z.number().nullable().optional(),
  type: z.string(),
  updatedAt: z.coerce.date(),
  userDisplay: z.string().optional(),
  userId: z.string(),
});

export const usageLogOutputSchema = z.object({
  date: z.number(),
  day: z.string(),
  records: z.array(usageRecordOutputSchema),
  totalRequests: z.number(),
  totalSpend: z.number(),
  totalTokens: z.number(),
});

export type SafeUsageRecord = z.infer<typeof usageRecordOutputSchema>;
export type SafeUsageLog = z.infer<typeof usageLogOutputSchema>;

/** Strip all provenance / tool snapshot fields; keep analytics-only columns. */
export const toSafeUsageRecord = (row: GlobalUsageRecordItem): SafeUsageRecord => ({
  createdAt: row.createdAt,
  id: row.id,
  metadata: null,
  model: row.model,
  provider: row.provider,
  spend: row.spend,
  totalInputTokens: row.totalInputTokens ?? null,
  totalOutputTokens: row.totalOutputTokens ?? null,
  totalTokens: row.totalTokens ?? null,
  tps: row.tps ?? null,
  ttft: row.ttft ?? null,
  type: row.type,
  updatedAt: row.updatedAt,
  userDisplay: row.userDisplay,
  userId: row.userId,
});

/** Redact embedded records while preserving full daily arrays and aggregate totals. */
export const toSafeUsageLogs = (logs: GlobalUsageLog[]): SafeUsageLog[] =>
  logs.map((log) => ({
    date: log.date,
    day: log.day,
    records: log.records.map(toSafeUsageRecord),
    totalRequests: log.totalRequests,
    totalSpend: log.totalSpend,
    totalTokens: log.totalTokens,
  }));

/**
 * Public usage APIs return a plain full array (no `{ items, nextCursor }` envelope).
 * Prefer a single bounded SQL fetch (routers/F4); fall back to keyset page walks.
 * Always fail closed with `usage_month_truncated` when the row budget is exhausted.
 */
/** @internal exported for truncation regression tests */
export const loadAllMonthUsage = async (
  model: PlatformGlobalStatsModel,
  filter?: StatsFilterArg,
): Promise<GlobalUsageRecordItem[]> => {
  const failTruncated = () =>
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: {
        maxPages: USAGE_FULL_MONTH_MAX_PAGES,
        maxRows: USAGE_FULL_MONTH_MAX_ROWS,
        reason: 'usage_month_truncated',
      },
      httpCode: 'BAD_REQUEST',
      message: 'Month usage exceeds the maximum full-fetch limit; use a narrower range',
    });

  // Hot path: one aggregate-sized SELECT with LIMIT maxRows+1 (no 200 serial pages).
  if (typeof model.findByMonthBounded === 'function') {
    const result = await model.findByMonthBounded(filter, USAGE_FULL_MONTH_MAX_ROWS);
    if (result.hasMore) return failTruncated();
    return result.items;
  }

  if (typeof model.findByMonthPage === 'function') {
    const items: GlobalUsageRecordItem[] = [];
    let cursor: string | undefined;
    // Fallback page walk (stubs / older model surface). Fail closed at page budget (F8).
    for (let page = 0; page < USAGE_FULL_MONTH_MAX_PAGES; page += 1) {
      const result = await model.findByMonthPage(filter, {
        cursor,
        limit: PlatformGlobalStatsModel.USAGE_PAGE_MAX,
      });
      items.push(...result.items);
      if (!result.nextCursor) return items;
      cursor = result.nextCursor;
    }
    return failTruncated();
  }
  return model.findByMonth(filter);
};

export const attachSafeRecordsByDay = (
  logs: GlobalUsageLog[],
  rows: SafeUsageRecord[],
): SafeUsageLog[] => {
  const byDay = new Map<string, SafeUsageRecord[]>();
  for (const row of rows) {
    const day = dayjs(row.createdAt).format('YYYY-MM-DD');
    const bucket = byDay.get(day);
    if (bucket) bucket.push(row);
    else byDay.set(day, [row]);
  }
  return logs.map((log) => ({
    date: log.date,
    day: log.day,
    records: byDay.get(log.day) ?? [],
    totalRequests: log.totalRequests,
    totalSpend: log.totalSpend,
    totalTokens: log.totalTokens,
  }));
};

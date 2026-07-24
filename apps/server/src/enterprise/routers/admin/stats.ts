/**
 * admin.stats router — global platform data statistics (read-only).
 *
 * Usage endpoints never return raw message metadata (tool snapshots, local files,
 * arguments/results). Full redacted month results are returned so daily analytics
 * that aggregate `records` stay accurate; SQL-level bounds live in globalStats.
 */
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import {
  type GlobalUsageLog,
  type GlobalUsageRecordItem,
  PlatformGlobalStatsModel,
} from '@/database/models/platform/globalStats';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';

dayjs.extend(customParseFormat);

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const statsProcedure = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.STATS_READ));
/**
 * Topic titles/ids are conversation evidence — require both STATS_READ and
 * AUDIT_CONVERSATION_READ (F4). Single gate so authorization reconcile stays 1:1.
 */
const statsTopicRankProcedure = adminBase.use(
  withAllPlatformPermissions([
    PLATFORM_PERMISSIONS.STATS_READ,
    PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ,
  ]),
);

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

const monthInput = z
  .object({
    mo: monthString.optional(),
  })
  .optional();

const countDateInput = z
  .object({
    endDate: isoDateString.optional(),
    range: z.tuple([isoDateString, isoDateString]).optional(),
    startDate: isoDateString.optional(),
  })
  .optional()
  .superRefine((value, ctx) => {
    if (!value) return;
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

/** Whitelist projection for usage rows — excludes raw metadata / tool snapshots. */
const usageRecordOutputSchema = z.object({
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

const usageLogOutputSchema = z.object({
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
  mo?: string,
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
    const result = await model.findByMonthBounded(mo, USAGE_FULL_MONTH_MAX_ROWS);
    if (result.hasMore) return failTruncated();
    return result.items;
  }

  if (typeof model.findByMonthPage === 'function') {
    const items: GlobalUsageRecordItem[] = [];
    let cursor: string | undefined;
    // Fallback page walk (stubs / older model surface). Fail closed at page budget (F8).
    for (let page = 0; page < USAGE_FULL_MONTH_MAX_PAGES; page += 1) {
      const result = await model.findByMonthPage(mo, {
        cursor,
        limit: PlatformGlobalStatsModel.USAGE_PAGE_MAX,
      });
      items.push(...result.items);
      if (!result.nextCursor) return items;
      cursor = result.nextCursor;
    }
    return failTruncated();
  }
  return model.findByMonth(mo);
};

const attachSafeRecordsByDay = (
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

export const adminStatsRouter = router({
  countAgents: statsProcedure.input(countDateInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.countAgents(input);
  }),

  countMessages: statsProcedure.input(countDateInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.countMessages(input);
  }),

  countTopics: statsProcedure.input(countDateInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.countTopics(input);
  }),

  getHeatmaps: statsProcedure.query(async ({ ctx }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.getHeatmaps();
  }),

  getMaxTaskDuration: statsProcedure.query(async ({ ctx }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.getMaxTaskDuration();
  }),

  getTokenHeatmaps: statsProcedure.query(async ({ ctx }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.getTokenHeatmaps();
  }),

  rankAgents: statsProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return model.rankAgents(input?.limit);
    }),

  rankModels: statsProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return model.rankModels(input?.limit);
    }),

  rankTopics: statsTopicRankProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return model.rankTopics(input?.limit);
    }),

  totals: statsProcedure
    .input(z.object({ activeDays: z.number().int().min(1).max(365).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return model.totals({ activeDays: input?.activeDays });
    }),

  /** User totals only — no lifetime message/topic/agent full-table counts. */
  userTotals: statsProcedure
    .input(z.object({ activeDays: z.number().int().min(1).max(365).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return model.userTotals({ activeDays: input?.activeDays });
    }),

  /**
   * Bounded daily token totals for the admin overview chart.
   * Response is only `{ day, totalTokens }[]` — never per-message records.
   */
  usageDailyTokenTotals: statsProcedure
    .input(monthInput)
    .output(
      z.array(
        z.object({
          day: z.string(),
          totalTokens: z.number(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return model.findDailyTokenTotals(input?.mo);
    }),

  usageFindAndGroupByDay: statsProcedure
    .input(monthInput)
    .output(z.array(usageLogOutputSchema))
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      const logs = await model.findAndGroupByDay(input?.mo);
      // Chart models may SQL-aggregate with empty `records`; clients/tests still need
      // redacted detail under each day (UI aggregates `records`).
      if (logs.some((log) => log.records.length > 0)) {
        return toSafeUsageLogs(logs);
      }
      const safeRows = (await loadAllMonthUsage(model, input?.mo)).map(toSafeUsageRecord);
      return attachSafeRecordsByDay(logs, safeRows);
    }),

  /**
   * Detailed usage rows for a month. Always redacted; returns the full redacted set
   * as a plain array (no pagination envelope) so clients that aggregate records are
   * not undercounted.
   */
  usageFindByMonth: statsProcedure
    .input(monthInput)
    .output(z.array(usageRecordOutputSchema))
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      const rows = await loadAllMonthUsage(model, input?.mo);
      return rows.map(toSafeUsageRecord);
    }),
});

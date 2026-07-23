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
import { withPlatformPermission } from '../../guards/platformPermission';

dayjs.extend(customParseFormat);

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const statsProcedure = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.STATS_READ));

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

  rankTopics: statsProcedure
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

  usageFindAndGroupByDay: statsProcedure
    .input(monthInput)
    .output(z.array(usageLogOutputSchema))
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      const logs = await model.findAndGroupByDay(input?.mo);
      return toSafeUsageLogs(logs);
    }),

  /**
   * Detailed usage rows for a month. Always redacted; returns the full redacted set
   * (shape-compatible array) so clients that aggregate records are not undercounted.
   * SQL-level pagination/aggregation is a database-layer concern.
   */
  usageFindByMonth: statsProcedure
    .input(monthInput)
    .output(z.array(usageRecordOutputSchema))
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      const rows = await model.findByMonth(input?.mo);
      return rows.map(toSafeUsageRecord);
    }),
});

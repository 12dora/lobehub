/**
 * admin.stats router — global platform data statistics (read-only).
 *
 * Usage endpoints never return raw message metadata (tool snapshots, local files,
 * arguments/results). Full redacted month results are returned so daily analytics
 * that aggregate `records` stay accurate; SQL-level bounds live in globalStats.
 */
import { z } from 'zod';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformGlobalStatsModel } from '@/database/models/platform/globalStats';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';
import {
  activitySeriesInput,
  activitySeriesOutput,
  attachSafeRecordsByDay,
  countDateInput,
  loadAllMonthUsage,
  monthInput,
  rangeShape,
  rankInput,
  rankUsersInput,
  refineRange,
  statsRangeInput,
  toSafeUsageLogs,
  toSafeUsageRecord,
  usageLogOutputSchema,
  usageRecordOutputSchema,
  userRankOutput,
  withRangeErrors,
} from './statsSupport';

export type { SafeUsageLog, SafeUsageRecord } from './statsSupport';
export { loadAllMonthUsage, toSafeUsageLogs, toSafeUsageRecord };

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

export const adminStatsRouter = router({
  /**
   * Zero-filled activity buckets for the selected window, in the requested time zone.
   * Response is only `{ bucket, count, level }[]` — never per-message records.
   */
  activitySeries: statsProcedure
    .input(activitySeriesInput)
    .output(activitySeriesOutput)
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return withRangeErrors(() => model.findActivitySeries(input));
    }),

  countAgents: statsProcedure.input(countDateInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return withRangeErrors(() => model.countAgents(input));
  }),

  countMessages: statsProcedure.input(countDateInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return withRangeErrors(() => model.countMessages(input));
  }),

  countTopics: statsProcedure.input(countDateInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return withRangeErrors(() => model.countTopics(input));
  }),

  getHeatmaps: statsProcedure.query(async ({ ctx }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.getHeatmaps();
  }),

  /** Longest completed task. An explicit window narrows it; omitted, it keeps the trailing year. */
  getMaxTaskDuration: statsProcedure
    .input(statsRangeInput.optional().superRefine(refineRange))
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return withRangeErrors(() => model.getMaxTaskDuration(input));
    }),

  getTokenHeatmaps: statsProcedure.query(async ({ ctx }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.getTokenHeatmaps();
  }),

  rankAgents: statsProcedure.input(rankInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return withRangeErrors(() => model.rankAgents(input?.limit, input));
  }),

  rankModels: statsProcedure.input(rankInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return withRangeErrors(() => model.rankModels(input?.limit, input));
  }),

  rankTopics: statsTopicRankProcedure.input(rankInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return withRangeErrors(() => model.rankTopics(input?.limit, input));
  }),

  /**
   * Users ranked by token usage in the window (admin 用户排行).
   * Emits a display name (fullName → username → email → id) and the avatar only —
   * never a standalone email field. Token / cost sums cover assistant rows only;
   * `messages` counts every role. Defaults to the last 30 days when no window is given,
   * and to `orderBy: 'totalTokens'` when no metric is given.
   */
  rankUsers: statsProcedure
    .input(rankUsersInput)
    .output(userRankOutput)
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return withRangeErrors(() =>
        model.rankUsers({
          endAt: input?.endAt,
          limit: input?.limit ?? 10,
          orderBy: input?.orderBy ?? 'totalTokens',
          startAt: input?.startAt,
          userId: input?.userId,
        }),
      );
    }),

  totals: statsProcedure
    .input(z.object({ activeDays: z.number().int().min(1).max(365).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return model.totals({ activeDays: input?.activeDays });
    }),

  /** User totals only — no lifetime message/topic/agent full-table counts. */
  userTotals: statsProcedure
    .input(
      z
        .object({
          activeDays: z.number().int().min(1).max(365).optional(),
          ...rangeShape,
        })
        .optional()
        .superRefine(refineRange),
    )
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return withRangeErrors(() =>
        model.userTotals({
          activeDays: input?.activeDays,
          endAt: input?.endAt,
          startAt: input?.startAt,
        }),
      );
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
      return withRangeErrors(() => model.findDailyTokenTotals(input));
    }),

  usageFindAndGroupByDay: statsProcedure
    .input(monthInput)
    .output(z.array(usageLogOutputSchema))
    .query(async ({ ctx, input }) => {
      const model = new PlatformGlobalStatsModel(ctx.serverDB);
      return withRangeErrors(async () => {
        const logs = await model.findAndGroupByDay(input);
        // Chart models may SQL-aggregate with empty `records`; clients/tests still need
        // redacted detail under each day (UI aggregates `records`).
        if (logs.some((log) => log.records.length > 0)) {
          return toSafeUsageLogs(logs);
        }
        const safeRows = (await loadAllMonthUsage(model, input)).map(toSafeUsageRecord);
        return attachSafeRecordsByDay(logs, safeRows);
      });
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
      return withRangeErrors(async () => {
        const rows = await loadAllMonthUsage(model, input);
        return rows.map(toSafeUsageRecord);
      });
    }),
});

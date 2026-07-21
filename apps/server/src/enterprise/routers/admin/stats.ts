/**
 * admin.stats router — global platform data statistics (read-only).
 */
import { z } from 'zod';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformGlobalStatsModel } from '@/database/models/platform/globalStats';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const statsProcedure = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.STATS_READ));

const monthInput = z
  .object({
    mo: z.string().optional(),
  })
  .optional();

const countDateInput = z
  .object({
    endDate: z.string().optional(),
    range: z.tuple([z.string(), z.string()]).optional(),
    startDate: z.string().optional(),
  })
  .optional();

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

  usageFindAndGroupByDay: statsProcedure.input(monthInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.findAndGroupByDay(input?.mo);
  }),

  usageFindByMonth: statsProcedure.input(monthInput).query(async ({ ctx, input }) => {
    const model = new PlatformGlobalStatsModel(ctx.serverDB);
    return model.findByMonth(input?.mo);
  }),
});

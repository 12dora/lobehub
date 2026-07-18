import { after } from 'next/server';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { AgentModel } from '@/database/models/agent';
import { AgentMigrationRepo } from '@/database/repositories/agentMigration';
import { HomeRepository } from '@/database/repositories/home';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { withActiveUserWhenManagedAgents } from '@/server/enterprise/guards/activeUser';
import { withManagedResourceGuard } from '@/server/enterprise/guards/managedResource';
import { PlatformAgentUserListService } from '@/server/enterprise/services/agentCatalog';
import { type HomeBriefData, HomeService } from '@/server/services/home';

const homeProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  const workspaceId = ctx.workspaceId ?? undefined;

  return opts.next({
    ctx: {
      agentMigrationRepo: new AgentMigrationRepo(ctx.serverDB, ctx.userId, workspaceId),
      agentModel: new AgentModel(ctx.serverDB, ctx.userId, workspaceId),
      homeRepository: new HomeRepository(ctx.serverDB, ctx.userId, workspaceId),
      homeService: new HomeService(ctx.userId),
      // Enterprise adapter (M10 PR-049 · A). Kept out of HomeRepository so the database layer
      // never depends on enterprise code. Flag off → merges nothing with zero catalog access.
      platformAgentListService: new PlatformAgentUserListService(ctx.serverDB),
    },
  });
});

export const homeRouter = router({
  getDailyBrief: homeProcedure.query(({ ctx }): Promise<HomeBriefData> =>
    ctx.homeService.getDailyBrief(),
  ),

  getSidebarAgentList: homeProcedure
    .use(withActiveUserWhenManagedAgents())
    .query(async ({ ctx }) => {
      const base = await ctx.homeRepository.getSidebarAgentList();
      // Merge effective platform agents into the main sidebar list (never materializes).
      const result = await ctx.platformAgentListService.mergeSidebarList(ctx.userId, base);

      // Runtime migration: backfill sessionGroupId for legacy agents
      const runMigration = async () => {
        try {
          await ctx.agentMigrationRepo.migrateSessionGroupId();
        } catch (error) {
          console.error('[AgentMigration] Failed to migrate sessionGroupId:', error);
        }
      };

      // Use Next.js after() for non-blocking execution
      after(runMigration);

      return result;
    }),

  searchAgents: homeProcedure
    .use(withActiveUserWhenManagedAgents())
    .input(z.object({ keyword: z.string() }))
    .query(async ({ input, ctx }) => {
      const base = await ctx.homeRepository.searchAgents(input.keyword);
      return ctx.platformAgentListService.mergeSearchResults(ctx.userId, base, input.keyword);
    }),

  updateAgentSessionGroupId: homeProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('home.updateAgentSessionGroupId'))
    .input(
      z.object({
        agentId: z.string(),
        sessionGroupId: z.string().nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.updateSessionGroupId(input.agentId, input.sessionGroupId);
    }),
});

export type HomeRouter = typeof homeRouter;

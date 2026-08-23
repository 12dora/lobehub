import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { router } from '@/libs/trpc/lambda';

import {
  adminPlatformAgentRolloutCancelInputSchema,
  adminPlatformAgentRolloutCancelOutputSchema,
  adminPlatformAgentRolloutGetInputSchema,
  adminPlatformAgentRolloutGetOutputSchema,
  adminPlatformAgentRolloutListInputSchema,
  adminPlatformAgentRolloutListOutputSchema,
  adminPlatformAgentRolloutRetryInputSchema,
  adminPlatformAgentRolloutRetryOutputSchema,
  adminPlatformAgentRolloutRollbackInputSchema,
  adminPlatformAgentRolloutRollbackOutputSchema,
  adminPlatformAgentRolloutStartInputSchema,
  adminPlatformAgentRolloutStartOutputSchema,
} from '../../contracts/platformAgents';
import { withPlatformPermission } from '../../guards/platformPermission';
import { PlatformAgentRolloutService } from '../../services/agentCatalog';
import { rolloutBase, rolloutMutation } from './agents.procedure';
import { assertAgentFeatureEnabled, mapAgentServiceError } from './agentsSupport';

export const rolloutsRouter = router({
  cancel: rolloutBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_ASSIGN))
    .input(adminPlatformAgentRolloutCancelInputSchema)
    .output(adminPlatformAgentRolloutCancelOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await rolloutMutation({
        action: 'admin.agents.rollouts.cancel',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentRolloutService(ctx.serverDB).cancel(ctx.userId!, input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  get: rolloutBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_READ))
    .input(adminPlatformAgentRolloutGetInputSchema)
    .output(adminPlatformAgentRolloutGetOutputSchema)
    .query(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        return await new PlatformAgentRolloutService(ctx.serverDB).get(input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  list: rolloutBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_READ))
    .input(adminPlatformAgentRolloutListInputSchema)
    .output(adminPlatformAgentRolloutListOutputSchema)
    .query(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        return await new PlatformAgentRolloutService(ctx.serverDB).list(input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  retry: rolloutBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_ASSIGN))
    .input(adminPlatformAgentRolloutRetryInputSchema)
    .output(adminPlatformAgentRolloutRetryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await rolloutMutation({
        action: 'admin.agents.rollouts.retry',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentRolloutService(ctx.serverDB).retry(ctx.userId!, input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  rollback: rolloutBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_PUBLISH))
    .input(adminPlatformAgentRolloutRollbackInputSchema)
    .output(adminPlatformAgentRolloutRollbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await rolloutMutation({
        action: 'admin.agents.rollouts.rollback',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentRolloutService(ctx.serverDB).rollback(ctx.userId!, input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  start: rolloutBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_ASSIGN))
    .input(adminPlatformAgentRolloutStartInputSchema)
    .output(adminPlatformAgentRolloutStartOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await rolloutMutation({
        action: 'admin.agents.rollouts.start',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentRolloutService(ctx.serverDB).start(ctx.userId!, input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),
});

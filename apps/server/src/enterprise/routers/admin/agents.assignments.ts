import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { router } from '@/libs/trpc/lambda';

import {
  adminPlatformAgentAssignmentListInputSchema,
  adminPlatformAgentAssignmentListOutputSchema,
  adminPlatformAgentAssignmentPreviewInputSchema,
  adminPlatformAgentAssignmentPreviewOutputSchema,
  adminPlatformAgentAssignmentRemoveInputSchema,
  adminPlatformAgentAssignmentRemoveOutputSchema,
  adminPlatformAgentAssignmentUpsertInputSchema,
  adminPlatformAgentAssignmentUpsertOutputSchema,
} from '../../contracts/platformAgents';
import { withPlatformPermission } from '../../guards/platformPermission';
import { PlatformAgentAdminService } from '../../services/agentCatalog';
import { adminBase } from './agents.procedure';
import {
  assertAgentDangerousReauth,
  assertAgentFeatureEnabled,
  mapAgentServiceError,
} from './agentsSupport';

export const assignmentsRouter = router({
  list: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_READ))
    .input(adminPlatformAgentAssignmentListInputSchema)
    .output(adminPlatformAgentAssignmentListOutputSchema)
    .query(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).listAssignments(input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  preview: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_ASSIGN))
    .input(adminPlatformAgentAssignmentPreviewInputSchema)
    .output(adminPlatformAgentAssignmentPreviewOutputSchema)
    .query(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).previewAssignment(input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  remove: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_ASSIGN))
    .input(adminPlatformAgentAssignmentRemoveInputSchema)
    .output(adminPlatformAgentAssignmentRemoveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await assertAgentDangerousReauth({
        action: 'admin.agents.assignments.remove',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).removeAssignment(
          ctx.userId!,
          input,
        );
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  upsert: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_ASSIGN))
    .input(adminPlatformAgentAssignmentUpsertInputSchema)
    .output(adminPlatformAgentAssignmentUpsertOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await assertAgentDangerousReauth({
        action: 'admin.agents.assignments.upsert',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).upsertAssignment(
          ctx.userId!,
          input,
        );
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),
});

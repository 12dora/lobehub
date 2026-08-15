import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminPlatformAgentArchiveInputSchema,
  adminPlatformAgentArchiveOutputSchema,
  adminPlatformAgentAssignmentListInputSchema,
  adminPlatformAgentAssignmentListOutputSchema,
  adminPlatformAgentAssignmentPreviewInputSchema,
  adminPlatformAgentAssignmentPreviewOutputSchema,
  adminPlatformAgentAssignmentRemoveInputSchema,
  adminPlatformAgentAssignmentRemoveOutputSchema,
  adminPlatformAgentAssignmentUpsertInputSchema,
  adminPlatformAgentAssignmentUpsertOutputSchema,
  adminPlatformAgentCreateInputSchema,
  adminPlatformAgentCreateOutputSchema,
  adminPlatformAgentDeleteInputSchema,
  adminPlatformAgentDeleteOutputSchema,
  adminPlatformAgentDependentsInputSchema,
  adminPlatformAgentDependentsOutputSchema,
  adminPlatformAgentGetInputSchema,
  adminPlatformAgentGetOutputSchema,
  adminPlatformAgentListInputSchema,
  adminPlatformAgentListOutputSchema,
  adminPlatformAgentRollbackInputSchema,
  adminPlatformAgentRollbackOutputSchema,
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
  adminPlatformAgentSaveInputSchema,
  adminPlatformAgentSaveOutputSchema,
  adminPlatformAgentSetDefaultInboxInputSchema,
  adminPlatformAgentSetDefaultInboxOutputSchema,
  adminPlatformAgentValidateDependenciesInputSchema,
  adminPlatformAgentValidateDependenciesOutputSchema,
  adminPlatformAgentVersionsListInputSchema,
  adminPlatformAgentVersionsListOutputSchema,
} from '../../contracts/platformAgents';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';
import {
  PlatformAgentAdminService,
  PlatformAgentPublicationService,
  PlatformAgentRolloutService,
  validateExactPlatformAgentDependencies,
} from '../../services/agentCatalog';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
import { PlatformAuditService } from '../../services/platformAudit';
import {
  assertAgentDangerousReauth,
  assertAgentFeatureEnabled,
  mapAgentServiceError,
} from './agentsSupport';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());
const rolloutBase = preAccessAuthedProcedure
  .use(({ next }) => {
    // This synchronous env-only gate MUST precede serverDatabase, active-user and RBAC. With
    // ADMIN=1 + MANAGED_AGENTS=0 every rollout procedure exits with zero database/guard work.
    assertAgentFeatureEnabled();
    return next();
  })
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const assignmentsRouter = router({
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

const rolloutMutation = async (params: {
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertAgentDangerousReauth>[0]['authMethod'];
  reason: string;
  serverDB: Parameters<typeof assertAgentDangerousReauth>[0]['serverDB'];
  targetId: string;
}) =>
  assertAgentDangerousReauth({
    action: params.action,
    actorUserId: params.actorUserId,
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    reason: params.reason,
    serverDB: params.serverDB,
    targetId: params.targetId,
  });

const rolloutsRouter = router({
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

export const adminAgentsRouter = router({
  archive: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_DELETE))
    .input(adminPlatformAgentArchiveInputSchema)
    .output(adminPlatformAgentArchiveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await assertAgentDangerousReauth({
        action: 'admin.agents.archive',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).archive(ctx.userId!, input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  assignments: assignmentsRouter,

  // Create publishes the first version live, so it needs CREATE *and* PUBLISH (one gate —
  // denials are audited as admin.permission.denied).
  create: adminBase
    .use(
      withAllPlatformPermissions([
        PLATFORM_PERMISSIONS.AGENT_CREATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      ]),
    )
    .input(adminPlatformAgentCreateInputSchema)
    .output(adminPlatformAgentCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).create(ctx.userId!, input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  delete: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_DELETE))
    .input(adminPlatformAgentDeleteInputSchema)
    .output(adminPlatformAgentDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await assertAgentDangerousReauth({
        action: 'admin.agents.delete',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).delete(ctx.userId!, input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  get: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_READ))
    .input(adminPlatformAgentGetInputSchema)
    .output(adminPlatformAgentGetOutputSchema)
    .query(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).get(input.id);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  getDependents: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_READ))
    .input(adminPlatformAgentDependentsInputSchema)
    .output(adminPlatformAgentDependentsOutputSchema)
    .query(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).getDependents(input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  list: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_READ))
    .input(adminPlatformAgentListInputSchema)
    .output(adminPlatformAgentListOutputSchema)
    .query(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).list(input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  listVersions: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_READ))
    .input(adminPlatformAgentVersionsListInputSchema)
    .output(adminPlatformAgentVersionsListOutputSchema)
    .query(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).listVersions(input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  rollback: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_PUBLISH))
    .input(adminPlatformAgentRollbackInputSchema)
    .output(adminPlatformAgentRollbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await assertAgentDangerousReauth({
        action: 'admin.agents.rollback',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentPublicationService(ctx.serverDB).rollback(ctx.userId!, input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  rollouts: rolloutsRouter,

  /**
   * The single de-drafted agent write: appends an immutable version and publishes it live in
   * one transaction. Requires both AGENT_UPDATE and AGENT_PUBLISH (one gate) plus
   * dangerous-mutation reauth, exactly like the publish it replaced.
   */
  save: adminBase
    .use(
      withAllPlatformPermissions([
        PLATFORM_PERMISSIONS.AGENT_UPDATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      ]),
    )
    .input(adminPlatformAgentSaveInputSchema)
    .output(adminPlatformAgentSaveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await assertAgentDangerousReauth({
        action: 'admin.agents.save',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.agentId,
      });
      try {
        return await new PlatformAgentPublicationService(ctx.serverDB).save(ctx.userId!, input);
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  setDefaultInbox: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_PUBLISH))
    .input(adminPlatformAgentSetDefaultInboxInputSchema)
    .output(adminPlatformAgentSetDefaultInboxOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await assertAgentDangerousReauth({
        action: 'admin.agents.setDefaultInbox',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.nextDefault.agentId,
      });
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).setDefaultInbox(
          ctx.userId!,
          input,
        );
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),

  validateDependencies: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_UPDATE))
    .input(adminPlatformAgentValidateDependenciesInputSchema)
    .output(adminPlatformAgentValidateDependenciesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      try {
        const result = await validateExactPlatformAgentDependencies(
          ctx.serverDB,
          input.dependencySnapshot,
        );
        try {
          await new PlatformAuditService(ctx.serverDB).append({
            action: 'admin.agents.validateDependencies',
            actorUserId: ctx.userId!,
            afterDiff: { valid: result.valid === true },
            result: 'success',
            targetType: 'agent_dependency_validation',
          });
        } catch (auditError) {
          console.error('[admin.agents] validateDependencies audit unavailable', {
            errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
          });
          // Validation already completed; do not reclassify as business failure.
        }
        return result;
      } catch (error) {
        try {
          await new PlatformAuditService(ctx.serverDB).append({
            action: 'admin.agents.validateDependencies',
            actorUserId: ctx.userId!,
            afterDiff: { error: 'validation_failed' },
            result: 'failure',
            targetType: 'agent_dependency_validation',
          });
        } catch (auditError) {
          console.error('[admin.agents] validateDependencies failure audit unavailable', {
            errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
          });
        }
        return mapAgentServiceError(error);
      }
    }),
});

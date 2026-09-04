import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { router } from '@/libs/trpc/lambda';

import {
  adminPlatformAgentArchiveInputSchema,
  adminPlatformAgentArchiveOutputSchema,
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
  adminPlatformAgentProvisionDefaultInboxInputSchema,
  adminPlatformAgentProvisionDefaultInboxOutputSchema,
  adminPlatformAgentRollbackInputSchema,
  adminPlatformAgentRollbackOutputSchema,
  adminPlatformAgentSaveInputSchema,
  adminPlatformAgentSaveOutputSchema,
  adminPlatformAgentSetDefaultInboxInputSchema,
  adminPlatformAgentSetDefaultInboxOutputSchema,
  adminPlatformAgentValidateDependenciesInputSchema,
  adminPlatformAgentValidateDependenciesOutputSchema,
  adminPlatformAgentVersionsListInputSchema,
  adminPlatformAgentVersionsListOutputSchema,
} from '../../contracts/platformAgents';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';
import {
  ensureDefaultInboxProvisioned,
  PlatformAgentAdminService,
  PlatformAgentPublicationService,
  validateExactPlatformAgentDependencies,
} from '../../services/agentCatalog';
import { PlatformAuditService } from '../../services/platformAudit';
import { assignmentsRouter } from './agents.assignments';
import { adminBase } from './agents.procedure';
import { rolloutsRouter } from './agents.rollouts';
import {
  assertAgentDangerousReauth,
  assertAgentFeatureEnabled,
  mapAgentServiceError,
} from './agentsSupport';

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
        await ensureDefaultInboxProvisioned(ctx.serverDB);
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

  provisionDefaultInbox: adminBase
    .use(
      withAllPlatformPermissions([
        PLATFORM_PERMISSIONS.AGENT_CREATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
        PLATFORM_PERMISSIONS.AGENT_ASSIGN,
      ]),
    )
    .input(adminPlatformAgentProvisionDefaultInboxInputSchema)
    .output(adminPlatformAgentProvisionDefaultInboxOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertAgentFeatureEnabled();
      await assertAgentDangerousReauth({
        action: 'admin.agents.provisionDefaultInbox',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        serverDB: ctx.serverDB,
        targetId: 'default-inbox',
      });
      try {
        return await new PlatformAgentAdminService(ctx.serverDB).provisionDefaultInbox({
          actorId: ctx.userId!,
          locale: input?.locale,
        });
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

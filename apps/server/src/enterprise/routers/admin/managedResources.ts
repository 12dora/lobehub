import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import {
  MANAGED_POLICY_RESOURCE_ID,
  MANAGED_POLICY_RESOURCE_TYPE,
} from '@/types/platform/managedResources';

import {
  adminManagedResourcesGetOutputSchema,
  adminManagedResourcesPublishInputSchema,
  adminManagedResourcesPublishOutputSchema,
  adminManagedResourcesSaveDraftInputSchema,
  adminManagedResourcesSaveDraftOutputSchema,
} from '../../contracts/adminManagedResources';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import {
  beginConnectorRuntimeEffectiveStateTransition,
  cancelConnectorRuntimeEffectiveStateTransition,
  finalizeConnectorRuntimeEffectiveStateTransition,
} from '../../services/connectorCatalog/runtimeEffectiveState';
import { resolvePublishedManagedResourcePolicies } from '../../services/managedResourceCapabilities';
import {
  ManagedResourceCatalogNotReadyError,
  ManagedResourcePolicyService,
  PlatformRevisionConflictError,
} from '../../services/managedResourcePolicy';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const assertPublishReauth = async (params: {
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
}) =>
  assertDangerousReauthWithAudit({
    action: 'admin.managedResources.publish',
    actorUserId: params.actorUserId,
    auditFailureLog: '[admin.managedResources.publish] reauth denied audit failed',
    // Legacy path only logged errorClass (no action).
    auditFailureMeta: {},
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    beforeDiff: null,
    reason: params.reason,
    serverDB: params.serverDB,
    targetId: MANAGED_POLICY_RESOURCE_ID,
    targetType: MANAGED_POLICY_RESOURCE_TYPE,
  });

export const adminManagedResourcesRouter = router({
  get: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.POLICY_READ))
    .output(adminManagedResourcesGetOutputSchema)
    .query(async ({ ctx }) => new ManagedResourcePolicyService(ctx.serverDB).get()),

  publish: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.POLICY_PUBLISH))
    .input(adminManagedResourcesPublishInputSchema)
    .output(adminManagedResourcesPublishOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertPublishReauth({
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      let connectorTransitionToken: string | null = null;
      // Track commit stage (not error class): cancel the transition whenever publish did not commit.
      let publishCommitted = false;
      try {
        const flags = parseEnterpriseFeatureFlags(process.env);
        connectorTransitionToken = flags.ENABLE_PLATFORM_MANAGED_CONNECTORS
          ? await beginConnectorRuntimeEffectiveStateTransition(input.expectedRevision)
          : null;
        if (flags.ENABLE_PLATFORM_MANAGED_CONNECTORS && !connectorTransitionToken) {
          // Close every direct MCP path before the policy pointer changes. If the
          // shared authority is unavailable, abort the publish instead of leaving
          // another instance on a stale legacy/enforced decision.
          throw new Error('Connector runtime transition authority unavailable');
        }
        const result = await new ManagedResourcePolicyService(ctx.serverDB).publish({
          actorUserId: ctx.userId!,
          comment: input.comment,
          expectedDraftToken: input.expectedDraftToken,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        });
        publishCommitted = true;
        const managed = await resolvePublishedManagedResourcePolicies({ db: ctx.serverDB, flags });
        const policy = managed.published.connectors;
        if (flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) {
          await finalizeConnectorRuntimeEffectiveStateTransition({
            mode:
              !policy.managed || policy.enforcementMode !== 'enforced'
                ? 'legacy'
                : managed.readiness.connectors
                  ? 'enforced'
                  : 'blocked',
            revision: managed.revision,
            token: connectorTransitionToken!,
          });
          connectorTransitionToken = null;
        }
        return result;
      } catch (error) {
        if (error instanceof PlatformRevisionConflictError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
            details: error.details as Record<string, string | number | boolean | null> | undefined,
            httpCode: 'CONFLICT',
          });
        }
        if (error instanceof ManagedResourceCatalogNotReadyError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
            details: { resourceCount: error.resources.length },
            httpCode: 'PRECONDITION_FAILED',
            message: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          });
        }
        throw error;
      } finally {
        // Cancel owned transition on any pre-commit failure (DB, audit, conflict, catalog, etc.).
        // After a confirmed commit, leave blocked mode for finalize / lease self-heal paths.
        if (connectorTransitionToken && !publishCommitted) {
          try {
            await cancelConnectorRuntimeEffectiveStateTransition(connectorTransitionToken);
          } catch (cleanupError) {
            console.error('[admin.managedResources.publish] transition cleanup failed', {
              errorClass: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
            });
          }
        }
      }
    }),

  saveDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.POLICY_UPDATE))
    .input(adminManagedResourcesSaveDraftInputSchema)
    .output(adminManagedResourcesSaveDraftOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await new ManagedResourcePolicyService(ctx.serverDB).saveDraft({
          actorUserId: ctx.userId!,
          draft: input.draft,
          expectedDraftToken: input.expectedDraftToken,
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof PlatformRevisionConflictError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
            details: error.details as Record<string, string | number | boolean | null> | undefined,
            httpCode: 'CONFLICT',
          });
        }
        throw error;
      }
    }),
});

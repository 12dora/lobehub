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
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertRecentReauth } from '../../guards/reauth';
import {
  publishConnectorRuntimeEffectiveState,
  reserveConnectorRuntimeEffectiveStateEpoch,
} from '../../services/connectorCatalog/runtimeEffectiveState';
import { resolvePublishedManagedResourcePolicies } from '../../services/managedResourceCapabilities';
import {
  ManagedResourceCatalogNotReadyError,
  ManagedResourcePolicyService,
  PlatformRevisionConflictError,
} from '../../services/managedResourcePolicy';
import { PlatformAuditService } from '../../services/platformAudit';

const adminBase = authedProcedure.use(serverDatabase).use(withActiveUser());

const assertPublishReauth = async (params: {
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
}) => {
  try {
    assertRecentReauth({
      authenticatedAt: params.authenticatedAt,
      authMethod: params.authMethod,
    });
  } catch (error) {
    try {
      await new PlatformAuditService(params.serverDB).append({
        action: 'admin.managedResources.publish',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'reauth_required' },
        beforeDiff: null,
        reason: params.reason,
        result: 'denied',
        targetId: MANAGED_POLICY_RESOURCE_ID,
        targetType: MANAGED_POLICY_RESOURCE_TYPE,
      });
    } catch (auditError) {
      console.error('[admin.managedResources.publish] reauth denied audit failed', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};

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
      try {
        const flags = parseEnterpriseFeatureFlags(process.env);
        const connectorStateEpoch = flags.ENABLE_PLATFORM_MANAGED_CONNECTORS
          ? await reserveConnectorRuntimeEffectiveStateEpoch()
          : 0;
        if (flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) {
          // Close every direct MCP path before the policy pointer changes. If the
          // shared authority is unavailable, abort the publish instead of leaving
          // another instance on a stale legacy/enforced decision.
          await publishConnectorRuntimeEffectiveState({
            epoch: connectorStateEpoch,
            mode: 'blocked',
            revision: input.expectedRevision,
          });
        }
        const result = await new ManagedResourcePolicyService(ctx.serverDB).publish({
          actorUserId: ctx.userId!,
          comment: input.comment,
          expectedDraftToken: input.expectedDraftToken,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        });
        const postCommitConnectorStateEpoch = flags.ENABLE_PLATFORM_MANAGED_CONNECTORS
          ? await reserveConnectorRuntimeEffectiveStateEpoch()
          : 0;
        const managed = await resolvePublishedManagedResourcePolicies({ db: ctx.serverDB, flags });
        const policy = managed.published.connectors;
        if (flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) {
          await publishConnectorRuntimeEffectiveState({
            epoch: postCommitConnectorStateEpoch,
            mode:
              !policy.managed || policy.enforcementMode !== 'enforced'
                ? 'legacy'
                : managed.readiness.connectors
                  ? 'enforced'
                  : 'blocked',
            revision: managed.revision,
          });
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

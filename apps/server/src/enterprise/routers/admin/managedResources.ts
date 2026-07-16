import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminManagedResourcesGetOutputSchema,
  adminManagedResourcesPublishInputSchema,
  adminManagedResourcesPublishOutputSchema,
  adminManagedResourcesSaveDraftInputSchema,
  adminManagedResourcesSaveDraftOutputSchema,
} from '../../contracts/adminManagedResources';
import { withActiveUser } from '../../guards/activeUser';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import {
  ManagedResourceCatalogNotReadyError,
  ManagedResourcePolicyService,
  PlatformRevisionConflictError,
} from '../../services/managedResourcePolicy';

const adminBase = authedProcedure.use(serverDatabase).use(withActiveUser());

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
      try {
        return await new ManagedResourcePolicyService(ctx.serverDB).publish({
          actorUserId: ctx.userId!,
          comment: input.comment,
          expectedDraftToken: input.expectedDraftToken,
          expectedRevision: input.expectedRevision,
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

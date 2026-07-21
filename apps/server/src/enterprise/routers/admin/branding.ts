import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { enterpriseAccessGate, preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminBrandingGetDraftOutputSchema,
  adminBrandingPublishInputSchema,
  adminBrandingPublishOutputSchema,
  adminBrandingRollbackInputSchema,
  adminBrandingRollbackOutputSchema,
  adminBrandingSaveDraftInputSchema,
  adminBrandingSaveDraftOutputSchema,
  adminBrandingUploadAssetInputSchema,
  adminBrandingUploadAssetOutputSchema,
} from '../../contracts/adminBranding';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertRecentReauth } from '../../guards/reauth';
import {
  AdminBrandingService,
  BrandingAssetCleanupClaimedError,
  BrandingAssetStorageUnavailableError,
  BrandingAssetUploadInProgressError,
  BrandingAssetValidationError,
  BrandingDraftValidationError,
  BrandingIdempotencyConflictError,
  BrandingOperationFailedReplayError,
  BrandingOperationInProgressError,
  BrandingOperationRecoveryPendingError,
  BrandingPersistenceInvariantError,
  PlatformRevisionConflictError,
} from '../../services/branding/adminBrandingService';
import { PlatformAuditService } from '../../services/platformAudit';

const assertBrandingFeatureEnabled = (): void => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_RUNTIME_BRANDING) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
      httpCode: 'FORBIDDEN',
    });
  }
};

/** Feature flag intentionally runs before access, database, active-user and RBAC middleware. */
const brandingProcedure = preAccessAuthedProcedure
  .use(({ next }) => {
    assertBrandingFeatureEnabled();
    return next();
  })
  .use(enterpriseAccessGate)
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const mapBrandingError = (error: unknown): never => {
  if (error instanceof BrandingIdempotencyConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_IDEMPOTENCY_CONFLICT,
      httpCode: 'CONFLICT',
    });
  }
  if (error instanceof PlatformRevisionConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      httpCode: 'CONFLICT',
    });
  }
  if (error instanceof BrandingOperationFailedReplayError) {
    if (error.category === 'revision_conflict') {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
        httpCode: 'CONFLICT',
      });
    }
    if (error.category === 'asset_storage_unavailable') {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_ASSET_STORAGE_UNAVAILABLE,
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    if (error.category === 'asset_invalid' || error.category === 'draft_invalid') {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        httpCode: 'BAD_REQUEST',
      });
    }
    if (error.category === 'upload_in_progress') {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
        httpCode: 'CONFLICT',
      });
    }
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Branding operation failed' });
  }
  if (
    error instanceof BrandingOperationInProgressError ||
    error instanceof BrandingOperationRecoveryPendingError
  ) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      httpCode: 'CONFLICT',
      message: 'Branding operation is pending recovery',
    });
  }
  if (error instanceof BrandingAssetStorageUnavailableError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_ASSET_STORAGE_UNAVAILABLE,
      httpCode: 'PRECONDITION_FAILED',
      message: 'Branding asset storage is not configured',
    });
  }
  if (error instanceof BrandingAssetUploadInProgressError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      httpCode: 'CONFLICT',
      message: 'Branding asset upload is still in progress',
    });
  }
  if (
    error instanceof BrandingAssetValidationError ||
    error instanceof BrandingAssetCleanupClaimedError ||
    error instanceof BrandingDraftValidationError
  ) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'BAD_REQUEST',
    });
  }
  if (error instanceof BrandingPersistenceInvariantError) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Branding state unavailable' });
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Branding operation failed' });
};

const assertDangerousReauth = async (params: {
  action: string;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
  reason: string;
  requestId: string;
  serverDB: ConstructorParameters<typeof AdminBrandingService>[0];
}): Promise<void> => {
  try {
    assertRecentReauth({
      authenticatedAt: params.authenticatedAt,
      authMethod: params.authMethod,
    });
  } catch (error) {
    try {
      await new PlatformAuditService(params.serverDB).append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'reauth_required' },
        reason: params.reason,
        requestId: params.requestId,
        result: 'denied',
        targetId: 'global',
        targetType: 'branding',
      });
    } catch {
      // Denied audit is best-effort and never bypasses reauthentication.
    }
    throw error;
  }
};

export const adminBrandingRouter = router({
  getDraft: brandingProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.BRANDING_READ))
    .output(adminBrandingGetDraftOutputSchema)
    .query(async ({ ctx }) => {
      try {
        return await new AdminBrandingService(ctx.serverDB).getDraft();
      } catch (error) {
        return mapBrandingError(error);
      }
    }),

  publish: brandingProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.BRANDING_PUBLISH))
    .input(adminBrandingPublishInputSchema)
    .output(adminBrandingPublishOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'platform.branding.publish',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        requestId: input.requestId,
        serverDB: ctx.serverDB,
      });
      try {
        return await new AdminBrandingService(ctx.serverDB).publish(ctx.userId!, input);
      } catch (error) {
        return mapBrandingError(error);
      }
    }),

  rollback: brandingProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.BRANDING_PUBLISH))
    .input(adminBrandingRollbackInputSchema)
    .output(adminBrandingRollbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.branding.rollback',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        requestId: input.requestId,
        serverDB: ctx.serverDB,
      });
      try {
        return await new AdminBrandingService(ctx.serverDB).rollback(ctx.userId!, input);
      } catch (error) {
        return mapBrandingError(error);
      }
    }),

  saveDraft: brandingProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.BRANDING_UPDATE))
    .input(adminBrandingSaveDraftInputSchema)
    .output(adminBrandingSaveDraftOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await new AdminBrandingService(ctx.serverDB).saveDraft(ctx.userId!, input);
      } catch (error) {
        return mapBrandingError(error);
      }
    }),

  uploadAsset: brandingProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.BRANDING_UPDATE))
    .input(adminBrandingUploadAssetInputSchema)
    .output(adminBrandingUploadAssetOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await new AdminBrandingService(ctx.serverDB).uploadAsset(ctx.userId!, input);
      } catch (error) {
        return mapBrandingError(error);
      }
    }),
});

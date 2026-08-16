import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminBrandingGetOutputSchema,
  adminBrandingSaveInputSchema,
  adminBrandingSaveOutputSchema,
  adminBrandingUploadAssetInputSchema,
  adminBrandingUploadAssetOutputSchema,
} from '../../contracts/adminBranding';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
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

const assertBrandingFeatureEnabled = (): void => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_RUNTIME_BRANDING) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
      httpCode: 'FORBIDDEN',
    });
  }
};

/** Feature flag intentionally runs before database, active-user and RBAC middleware. */
const brandingProcedure = preAccessAuthedProcedure
  .use(({ next }) => {
    assertBrandingFeatureEnabled();
    return next();
  })
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
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason: string;
  requestId: string;
  serverDB: ConstructorParameters<typeof AdminBrandingService>[0];
}): Promise<void> =>
  assertDangerousReauthWithAudit({
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    serverDB: params.serverDB,
    denied: {
      action: params.action,
      actorUserId: params.actorUserId,
      reason: params.reason,
      requestId: params.requestId,
      targetId: 'global',
      targetType: 'branding',
    },
  });

export const adminBrandingRouter = router({
  get: brandingProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.BRANDING_READ))
    .output(adminBrandingGetOutputSchema)
    .query(async ({ ctx }) => {
      try {
        return await new AdminBrandingService(ctx.serverDB).get();
      } catch (error) {
        return mapBrandingError(error);
      }
    }),

  /**
   * The single de-drafted branding write: saving publishes the payload site-wide.
   * Requires both BRANDING_UPDATE and BRANDING_PUBLISH (single middleware gate) plus
   * dangerous-mutation reauth.
   */
  save: brandingProcedure
    .use(
      withAllPlatformPermissions([
        PLATFORM_PERMISSIONS.BRANDING_UPDATE,
        PLATFORM_PERMISSIONS.BRANDING_PUBLISH,
      ]),
    )
    .input(adminBrandingSaveInputSchema)
    .output(adminBrandingSaveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.branding.save',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        requestId: input.requestId,
        serverDB: ctx.serverDB,
      });
      try {
        return await new AdminBrandingService(ctx.serverDB).save(ctx.userId!, input);
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

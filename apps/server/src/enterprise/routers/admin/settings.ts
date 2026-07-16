import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminSettingsGetDraftOutputSchema,
  adminSettingsPublishInputSchema,
  adminSettingsPublishOutputSchema,
  adminSettingsRollbackInputSchema,
  adminSettingsRollbackOutputSchema,
  adminSettingsSaveDraftInputSchema,
  adminSettingsSaveDraftOutputSchema,
  adminSettingsValidateDraftInputSchema,
  adminSettingsValidateDraftOutputSchema,
} from '../../contracts/adminSettings';
import { getEnterpriseFeatureFlags } from '../../featureFlags';
import { withActiveUser } from '../../guards/activeUser';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import {
  AdminSettingsService,
  PlatformRevisionConflictError,
  SettingsDraftValidationError,
} from '../../services/settings/adminSettingsService';

const adminBase = authedProcedure.use(serverDatabase).use(withActiveUser());

const assertSettingsFeature = () => {
  if (!getEnterpriseFeatureFlags().ENABLE_PLATFORM_SETTINGS_POLICY) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
      httpCode: 'FORBIDDEN',
      message: 'Platform settings policy is disabled',
    });
  }
};

/**
 * admin.settings.* — draft / validate / publish / rollback.
 * Permissions: platform_settings:read/update/publish:all exactly.
 * ai_admin has SETTINGS_READ only (catalog); mutations require update/publish.
 */
export const adminSettingsRouter = router({
  getDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SETTINGS_READ))
    .output(adminSettingsGetDraftOutputSchema)
    .query(async ({ ctx }) => {
      assertSettingsFeature();
      const service = new AdminSettingsService(ctx.serverDB);
      return service.getDraft();
    }),

  saveDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SETTINGS_UPDATE))
    .input(adminSettingsSaveDraftInputSchema)
    .output(adminSettingsSaveDraftOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertSettingsFeature();
      const service = new AdminSettingsService(ctx.serverDB);
      try {
        return await service.saveDraft({
          actorUserId: ctx.userId!,
          draft: input.draft,
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof SettingsDraftValidationError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
            details: { issueCount: error.issues.length },
            httpCode: 'BAD_REQUEST',
            message:
              error.issues[0]?.message ?? PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          });
        }
        throw error;
      }
    }),

  validateDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SETTINGS_READ))
    .input(adminSettingsValidateDraftInputSchema)
    .output(adminSettingsValidateDraftOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertSettingsFeature();
      const service = new AdminSettingsService(ctx.serverDB);
      const draft =
        input.draft ??
        ((await service.getDraft()).draft as Parameters<typeof service.validateDraft>[0]);
      return service.validateDraft(draft);
    }),

  publish: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SETTINGS_PUBLISH))
    .input(adminSettingsPublishInputSchema)
    .output(adminSettingsPublishOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertSettingsFeature();
      const service = new AdminSettingsService(ctx.serverDB);
      try {
        return await service.publish({
          actorUserId: ctx.userId!,
          comment: input.comment,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof SettingsDraftValidationError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
            details: { issueCount: error.issues.length },
            httpCode: 'BAD_REQUEST',
          });
        }
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

  rollback: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SETTINGS_PUBLISH))
    .input(adminSettingsRollbackInputSchema)
    .output(adminSettingsRollbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertSettingsFeature();
      const service = new AdminSettingsService(ctx.serverDB);
      try {
        return await service.rollback({
          actorUserId: ctx.userId!,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          targetRevision: input.targetRevision,
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

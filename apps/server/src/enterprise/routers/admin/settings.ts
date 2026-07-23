import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminSettingsApplyImmediateInputSchema,
  adminSettingsApplyImmediateOutputSchema,
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
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import { PlatformAuditService } from '../../services/platformAudit';
import {
  AdminSettingsService,
  PlatformRevisionConflictError,
  SettingsDirtyDraftError,
  SettingsDraftValidationError,
} from '../../services/settings/adminSettingsService';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

/** B9-R2: feature-disabled → denied audit, zero mutation. */
const assertSettingsFeature = async (params: {
  action: string;
  actorUserId: string;
  serverDB: LobeChatDatabase;
}) => {
  if (!getEnterpriseFeatureFlags().ENABLE_PLATFORM_SETTINGS_POLICY) {
    try {
      await new PlatformAuditService(params.serverDB).append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: null,
        beforeDiff: null,
        reason: 'feature_disabled',
        result: 'denied',
        targetId: 'global',
        targetType: 'settings',
      });
    } catch {
      /* best-effort */
    }
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
      httpCode: 'FORBIDDEN',
      message: 'Platform settings policy is disabled',
    });
  }
};

const assertSettingsDangerousReauth = async (params: {
  action: 'admin.settings.applyImmediate' | 'admin.settings.publish' | 'admin.settings.rollback';
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
}) =>
  assertDangerousReauthWithAudit({
    action: params.action,
    actorUserId: params.actorUserId,
    auditFailureLog: '[admin.settings] reauth denied audit unavailable',
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    reason: params.reason,
    serverDB: params.serverDB,
    targetId: 'global',
    targetType: 'settings',
  });

/**
 * admin.settings.* — draft / validate / publish / rollback.
 * Permissions: platform_settings:read/update/publish:all exactly.
 */
export const adminSettingsRouter = router({
  getDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SETTINGS_READ))
    .output(adminSettingsGetDraftOutputSchema)
    .query(async ({ ctx }) => {
      await assertSettingsFeature({
        action: 'admin.settings.getDraft',
        actorUserId: ctx.userId!,
        serverDB: ctx.serverDB,
      });
      const service = new AdminSettingsService(ctx.serverDB);
      return service.getDraft();
    }),

  /**
   * Merge path values into the platform settings draft and publish immediately.
   * Requires SETTINGS_UPDATE (middleware) + SETTINGS_PUBLISH (secondary).
   * Auto-publishes; rejects when draft has unpublished diffs outside the patch.
   */
  applyImmediate: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SETTINGS_UPDATE))
    .input(adminSettingsApplyImmediateInputSchema)
    .output(adminSettingsApplyImmediateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertSettingsFeature({
        action: 'admin.settings.applyImmediate',
        actorUserId: ctx.userId!,
        serverDB: ctx.serverDB,
      });

      const perms = (ctx as { platformAuth?: { permissions: string[] } }).platformAuth?.permissions;
      if (!perms?.includes(PLATFORM_PERMISSIONS.SETTINGS_PUBLISH)) {
        throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
          details: { permission: PLATFORM_PERMISSIONS.SETTINGS_PUBLISH },
          httpCode: 'FORBIDDEN',
          message: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
        });
      }

      const reason =
        input.reason ??
        `applyImmediate: ${Object.keys(input.patch).sort().slice(0, 12).join(', ')}`;

      await assertSettingsDangerousReauth({
        action: 'admin.settings.applyImmediate',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason,
        serverDB: ctx.serverDB,
      });

      const service = new AdminSettingsService(ctx.serverDB);
      try {
        return await service.applyImmediate({
          actorUserId: ctx.userId!,
          patch: input.patch,
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof SettingsDirtyDraftError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
            details: {
              dirtyPathCount: error.dirtyPaths.length,
              reason: 'unpublished_draft_outside_patch',
            },
            httpCode: 'BAD_REQUEST',
            message: error.message,
          });
        }
        if (error instanceof SettingsDraftValidationError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
            details: { issueCount: error.issues.length },
            httpCode: 'BAD_REQUEST',
            message:
              error.issues[0]?.message ?? PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
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

  saveDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SETTINGS_UPDATE))
    .input(adminSettingsSaveDraftInputSchema)
    .output(adminSettingsSaveDraftOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertSettingsFeature({
        action: 'admin.settings.saveDraft',
        actorUserId: ctx.userId!,
        serverDB: ctx.serverDB,
      });
      const service = new AdminSettingsService(ctx.serverDB);
      try {
        return await service.saveDraft({
          actorUserId: ctx.userId!,
          draft: input.draft,
          expectedDraftToken: input.expectedDraftToken,
          // TRPC policy-editor surface: never whole-table replace service-model rows.
          ownership: 'policy-editor',
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
        if (error instanceof PlatformRevisionConflictError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
            httpCode: 'CONFLICT',
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
      await assertSettingsFeature({
        action: 'admin.settings.validateDraft',
        actorUserId: ctx.userId!,
        serverDB: ctx.serverDB,
      });
      const service = new AdminSettingsService(ctx.serverDB);
      const draft =
        input.draft ??
        ((await service.getDraft()).draft as Parameters<typeof service.validateDraft>[0]);
      const result = await service.validateDraft(draft);
      try {
        await new PlatformAuditService(ctx.serverDB).append({
          action: 'admin.settings.validateDraft',
          actorUserId: ctx.userId!,
          afterDiff: {
            issueCount: result.issues.length,
            ok: result.ok,
          },
          result: result.ok ? 'success' : 'failure',
          targetType: 'settings_validation',
        });
      } catch (auditError) {
        console.error('[admin.settings] validateDraft audit unavailable', {
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
      return result;
    }),

  publish: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SETTINGS_PUBLISH))
    .input(adminSettingsPublishInputSchema)
    .output(adminSettingsPublishOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertSettingsFeature({
        action: 'admin.settings.publish',
        actorUserId: ctx.userId!,
        serverDB: ctx.serverDB,
      });
      await assertSettingsDangerousReauth({
        action: 'admin.settings.publish',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      const service = new AdminSettingsService(ctx.serverDB);
      try {
        return await service.publish({
          actorUserId: ctx.userId!,
          comment: input.comment,
          expectedDraftToken: input.expectedDraftToken,
          expectedRevision: input.expectedRevision,
          // TRPC policy-editor surface: never wipe service-model rows on publish.
          ownership: 'policy-editor',
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
      await assertSettingsFeature({
        action: 'admin.settings.rollback',
        actorUserId: ctx.userId!,
        serverDB: ctx.serverDB,
      });
      await assertSettingsDangerousReauth({
        action: 'admin.settings.rollback',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      const service = new AdminSettingsService(ctx.serverDB);
      try {
        return await service.rollback({
          actorUserId: ctx.userId!,
          expectedDraftToken: input.expectedDraftToken,
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

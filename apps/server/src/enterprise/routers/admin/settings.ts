import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminSettingsApplyImmediateInputSchema,
  adminSettingsApplyImmediateOutputSchema,
  adminSettingsGetDraftOutputSchema,
  adminSettingsSaveInputSchema,
  adminSettingsSaveOutputSchema,
} from '../../contracts/adminSettings';
import { getEnterpriseFeatureFlags } from '../../featureFlags';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
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
  action: AuditAction;
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
  action: 'admin.settings.applyImmediate' | 'admin.settings.save';
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
}) =>
  assertDangerousReauthWithAudit({
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    serverDB: params.serverDB,
    denied: {
      action: params.action,
      actorUserId: params.actorUserId,
      reason: params.reason,
      targetId: 'global',
      targetType: 'settings',
    },
  });

/**
 * admin.settings.* — read + immediate site-wide writes (no draft workflow).
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
   * Requires both SETTINGS_UPDATE and SETTINGS_PUBLISH (single middleware gate —
   * denials are audited as admin.permission.denied).
   * Auto-publishes; rejects when draft has unpublished diffs outside the patch.
   */
  applyImmediate: adminBase
    .use(
      withAllPlatformPermissions([
        PLATFORM_PERMISSIONS.SETTINGS_UPDATE,
        PLATFORM_PERMISSIONS.SETTINGS_PUBLISH,
      ]),
    )
    .input(adminSettingsApplyImmediateInputSchema)
    .output(adminSettingsApplyImmediateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertSettingsFeature({
        action: 'admin.settings.applyImmediate',
        actorUserId: ctx.userId!,
        serverDB: ctx.serverDB,
      });

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

  /**
   * De-drafted 统一管理 write: merge the policy-editor payload over the published
   * baseline and publish it site-wide in ONE transaction.
   * Requires both SETTINGS_UPDATE and SETTINGS_PUBLISH (single middleware gate —
   * denials are audited as admin.permission.denied) plus dangerous-mutation reauth.
   */
  save: adminBase
    .use(
      withAllPlatformPermissions([
        PLATFORM_PERMISSIONS.SETTINGS_UPDATE,
        PLATFORM_PERMISSIONS.SETTINGS_PUBLISH,
      ]),
    )
    .input(adminSettingsSaveInputSchema)
    .output(adminSettingsSaveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertSettingsFeature({
        action: 'admin.settings.save',
        actorUserId: ctx.userId!,
        serverDB: ctx.serverDB,
      });
      await assertSettingsDangerousReauth({
        action: 'admin.settings.save',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      const service = new AdminSettingsService(ctx.serverDB);
      try {
        return await service.save({
          actorUserId: ctx.userId!,
          comment: input.comment,
          expectedDraftToken: input.expectedDraftToken,
          expectedRevision: input.expectedRevision,
          policies: input.policies,
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
            details: error.details as Record<string, string | number | boolean | null> | undefined,
            httpCode: 'CONFLICT',
          });
        }
        throw error;
      }
    }),
});

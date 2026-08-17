import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformAuthSettingsModel } from '@/database/models/platform';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import {
  normalizeEmailDomainAllowlist,
  platformAuthSettingsSchema,
} from '@/types/platform/authSettings';

import {
  adminAuthSettingsGetOutputSchema,
  adminAuthSettingsUpdateInputSchema,
  adminAuthSettingsUpdateOutputSchema,
} from '../../contracts/adminAuthSettings';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { invalidatePlatformPublicSnapshot } from '../../services/branding/publicSnapshotCache';
import { PlatformAuditService } from '../../services/platformAudit';
import { getPlatformConfigInvalidationPublisher } from '../../services/platformConfigInvalidation';

const authSettingsBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

/**
 * Platform authentication / registration settings (M15).
 * Direct-save: `update` persists the whole document immediately (no draft/publish).
 * Gated on IDENTITY_* — registration policy is identity/login-adjacent.
 *
 * Config write + success audit share one DB transaction so an unavailable audit sink
 * cannot leave an unaudited committed change (fail closed). CAS via `revision`.
 *
 * Input/output schemas are the shared `adminAuthSettings*` contracts (SR-007 / SCT-04).
 */
export const adminAuthSettingsRouter = router({
  get: authSettingsBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_READ))
    .output(adminAuthSettingsGetOutputSchema)
    .query(async ({ ctx }) => new PlatformAuthSettingsModel(ctx.serverDB).get()),

  update: authSettingsBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_UPDATE))
    .input(adminAuthSettingsUpdateInputSchema)
    .output(adminAuthSettingsUpdateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const next = await ctx.serverDB.transaction(async (tx) => {
          const { expectedRevision, ...settingsPatch } = input;
          const parsed = platformAuthSettingsSchema.parse({
            emailDomainAllowlist: normalizeEmailDomainAllowlist(settingsPatch.emailDomainAllowlist),
            emailDomainAllowlistEnabled: settingsPatch.emailDomainAllowlistEnabled,
            openRegistration: settingsPatch.openRegistration,
          });

          const updated = await new PlatformAuthSettingsModel(
            tx as unknown as LobeChatDatabase,
          ).update(ctx.userId!, { ...parsed, expectedRevision });

          await new PlatformAuditService(tx).append({
            action: 'admin.authSettings.update',
            actorUserId: ctx.userId!,
            afterDiff: {
              emailDomainAllowlistEnabled: updated.emailDomainAllowlistEnabled,
              emailDomainCount: updated.emailDomainAllowlist.length,
              openRegistration: updated.openRegistration,
              revision: updated.revision,
            },
            configRevision: updated.revision,
            result: 'success',
            targetId: 'global',
            targetType: 'authSettings',
          });

          return updated;
        });

        invalidatePlatformPublicSnapshot();
        try {
          await getPlatformConfigInvalidationPublisher().publish({
            at: new Date().toISOString(),
            resourceId: 'global',
            resourceType: 'auth_settings',
            revision: next.revision,
            scopes: ['auth_settings'],
          });
        } catch {
          // Best-effort: local public-snapshot cache is already dropped.
        }

        return next;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (error instanceof PlatformRevisionConflictError) {
          return throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
            details: error.details as Record<string, string | number | boolean | null> | undefined,
          });
        }
        if (
          error instanceof Error &&
          (error.message === 'PLATFORM_AUTH_SETTINGS_ALLOWLIST_EMPTY' ||
            error.message.includes('allowlist_nonempty_when_enabled'))
        ) {
          return throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
            details: { issueCount: 1, reason: 'allowlist_empty_when_enabled' },
            httpCode: 'BAD_REQUEST',
          });
        }
        if (error instanceof z.ZodError) {
          return throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
            details: { issueCount: error.issues.length },
          });
        }
        // Permission / input errors from middleware already escaped; surface audit/write failure stably.
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          details: { issueCount: 1, reason: 'audit_or_write_failed' },
          httpCode: 'INTERNAL_SERVER_ERROR',
        });
      }
    }),
});

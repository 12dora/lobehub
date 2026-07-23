import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformAuthSettingsModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminAuthSettingsGetOutputSchema,
  adminAuthSettingsUpdateInputSchema,
  adminAuthSettingsUpdateOutputSchema,
} from '../../contracts/adminAuthSettings';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { PlatformAuditService } from '../../services/platformAudit';

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
 * cannot leave an unaudited committed change (fail closed).
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
        return await ctx.serverDB.transaction(async (tx) => {
          const next = await new PlatformAuthSettingsModel(
            tx as unknown as LobeChatDatabase,
          ).update(ctx.userId!, input);

          await new PlatformAuditService(tx).append({
            action: 'admin.authSettings.update',
            actorUserId: ctx.userId!,
            afterDiff: {
              emailDomainAllowlistEnabled: next.emailDomainAllowlistEnabled,
              emailDomainCount: next.emailDomainAllowlist.length,
              openRegistration: next.openRegistration,
            },
            result: 'success',
            targetId: 'global',
            targetType: 'authSettings',
          });

          return next;
        });
      } catch (error) {
        // Permission / input errors from middleware already escaped; surface audit/write failure stably.
        if (error instanceof TRPCError) throw error;
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          details: { issueCount: 1, reason: 'audit_or_write_failed' },
          httpCode: 'INTERNAL_SERVER_ERROR',
        });
      }
    }),
});

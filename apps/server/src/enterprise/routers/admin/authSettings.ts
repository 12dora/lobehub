import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformAuthSettingsModel } from '@/database/models/platform';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminAuthSettingsGetOutputSchema,
  adminAuthSettingsUpdateInputSchema,
  adminAuthSettingsUpdateOutputSchema,
} from '../../contracts/adminAuthSettings';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
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
      const next = await new PlatformAuthSettingsModel(ctx.serverDB).update(ctx.userId!, input);

      try {
        await new PlatformAuditService(ctx.serverDB).append({
          action: 'admin.authSettings.update',
          actorUserId: ctx.userId!,
          afterDiff: {
            emailDomainAllowlistEnabled: next.emailDomainAllowlistEnabled,
            emailDomainCount: next.emailDomainAllowlist.length,
            openRegistration: next.openRegistration,
          },
          result: 'succeeded',
          targetId: 'global',
          targetType: 'authSettings',
        });
      } catch {
        // Audit is best-effort and never blocks the settings write.
      }

      return next;
    }),
});

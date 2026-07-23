import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformSidebarLayoutModel } from '@/database/models/platform';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminSidebarLayoutGetOutputSchema,
  adminSidebarLayoutUpdateInputSchema,
  adminSidebarLayoutUpdateOutputSchema,
} from '../../contracts/adminSidebarLayout';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';
import { PlatformAuditService } from '../../services/platformAudit';

const sidebarLayoutBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

/**
 * Platform home-sidebar layout policy (M15).
 * Direct-save: `update` persists the whole document immediately (no draft/publish).
 * Gated on POLICY_* — it lives under the Managed Resources surface.
 */
export const adminSidebarLayoutRouter = router({
  get: sidebarLayoutBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.POLICY_READ))
    .output(adminSidebarLayoutGetOutputSchema)
    .query(async ({ ctx }) => new PlatformSidebarLayoutModel(ctx.serverDB).get()),

  update: sidebarLayoutBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.POLICY_UPDATE))
    .input(adminSidebarLayoutUpdateInputSchema)
    .output(adminSidebarLayoutUpdateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const next = await new PlatformSidebarLayoutModel(ctx.serverDB).update(ctx.userId!, input);

      try {
        await new PlatformAuditService(ctx.serverDB).append({
          action: 'admin.sidebarLayout.update',
          actorUserId: ctx.userId!,
          afterDiff: { hasLayout: Boolean(next.layout), mode: next.mode },
          result: 'succeeded',
          targetId: 'global',
          targetType: 'sidebarLayout',
        });
      } catch {
        // Audit is best-effort and never blocks the settings write.
      }

      return next;
    }),
});

import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformSidebarLayoutModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminSidebarLayoutGetOutputSchema,
  adminSidebarLayoutUpdateInputSchema,
  adminSidebarLayoutUpdateOutputSchema,
} from '../../contracts/adminSidebarLayout';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
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
 *
 * Config write + success audit share one DB transaction so an unavailable audit sink
 * cannot leave an unaudited committed change (fail closed).
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
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const next = await new PlatformSidebarLayoutModel(
            tx as unknown as LobeChatDatabase,
          ).update(ctx.userId!, input);

          await new PlatformAuditService(tx).append({
            action: 'admin.sidebarLayout.update',
            actorUserId: ctx.userId!,
            afterDiff: { hasLayout: Boolean(next.layout), mode: next.mode },
            result: 'success',
            targetId: 'global',
            targetType: 'sidebarLayout',
          });

          return next;
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          details: { issueCount: 1, reason: 'audit_or_write_failed' },
          httpCode: 'INTERNAL_SERVER_ERROR',
        });
      }
    }),
});

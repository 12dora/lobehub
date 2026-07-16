/**
 * admin.users router (M04).
 * All inputs/outputs use centralized contracts — do not redefine schemas here.
 */
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminUsersBanInputSchema,
  adminUsersGetAuditTrailInputSchema,
  adminUsersGetInputSchema,
  adminUsersListInputSchema,
  adminUsersReplaceGlobalRolesInputSchema,
  adminUsersRevokeSessionsInputSchema,
  adminUsersUnbanInputSchema,
} from '../../contracts/adminUsers';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertRecentReauth } from '../../guards/reauth';
import {
  AdminUserNotFoundError,
  AdminUserSelfBanError,
  AdminUserService,
} from '../../services/adminUserService';
import { LastSuperAdminError } from '../../services/platformRbac';

const adminBase = authedProcedure.use(serverDatabase);

const mapServiceError = (error: unknown): never => {
  if (error instanceof AdminUserNotFoundError) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
      httpCode: 'NOT_FOUND',
    });
  }
  if (error instanceof AdminUserSelfBanError) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { reason: 'self_ban' },
      httpCode: 'BAD_REQUEST',
    });
  }
  if (error instanceof LastSuperAdminError) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_LAST_SUPER_ADMIN,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  if (error instanceof Error && error.message === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      httpCode: 'FORBIDDEN',
    });
  }
  if (error instanceof Error && error.message === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      httpCode: 'BAD_REQUEST',
    });
  }
  throw error;
};

export const adminUsersRouter = router({
  list: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_READ))
    .input(adminUsersListInputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminUserService(ctx.serverDB);
      return service.list(input);
    }),

  get: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_READ))
    .input(adminUsersGetInputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.get(input.userId);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  getAuditTrail: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ))
    .input(adminUsersGetAuditTrailInputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.getAuditTrail(input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  ban: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .input(adminUsersBanInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertRecentReauth({
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
      });
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.ban({
          actorUserId: ctx.userId!,
          input,
        });
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  unban: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .input(adminUsersUnbanInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertRecentReauth({
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
      });
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.unban({
          actorUserId: ctx.userId!,
          input,
        });
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  revokeSessions: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_SESSION_REVOKE))
    .input(adminUsersRevokeSessionsInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertRecentReauth({
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
      });
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.revokeSessions({
          actorSessionId: ctx.sessionId,
          actorUserId: ctx.userId!,
          input,
        });
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  replaceGlobalRoles: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_ROLE_MANAGE))
    .input(adminUsersReplaceGlobalRolesInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertRecentReauth({
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
      });
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.replaceGlobalRoles({
          actorUserId: ctx.userId!,
          input,
        });
      } catch (error) {
        return mapServiceError(error);
      }
    }),
});

export type AdminUsersRouter = typeof adminUsersRouter;

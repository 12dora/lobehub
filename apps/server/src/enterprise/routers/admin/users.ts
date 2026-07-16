/**
 * admin.users router (M04).
 * All inputs/outputs use centralized contracts — do not redefine schemas here.
 */
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminUsersBanInputSchema,
  adminUsersBanOutputSchema,
  adminUsersGetAuditTrailInputSchema,
  adminUsersGetAuditTrailOutputSchema,
  adminUsersGetInputSchema,
  adminUsersGetOutputSchema,
  adminUsersListInputSchema,
  adminUsersListOutputSchema,
  adminUsersReplaceGlobalRolesInputSchema,
  adminUsersReplaceGlobalRolesOutputSchema,
  adminUsersRevokeSessionsInputSchema,
  adminUsersRevokeSessionsOutputSchema,
  adminUsersUnbanInputSchema,
  adminUsersUnbanOutputSchema,
} from '../../contracts/adminUsers';
import { withActiveUser } from '../../guards/activeUser';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertRecentReauth } from '../../guards/reauth';
import {
  AdminUserNotFoundError,
  AdminUserSelfBanError,
  AdminUserService,
  InvalidRetainedSessionError,
} from '../../services/adminUserService';
import { LastSuperAdminError } from '../../services/platformRbac';

const adminBase = authedProcedure.use(serverDatabase).use(withActiveUser());

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
  if (error instanceof InvalidRetainedSessionError) {
    // Public error does not disclose whether a foreign/missing session exists.
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { reason: 'retained_session_invalid' },
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

const withReauth = async <T>(
  ctx: {
    authenticatedAt?: Date | null;
    authMethod?: 'better-auth' | 'oidc' | 'api-key' | 'dev-mock' | null;
    serverDB: LobeChatDatabase;
    userId?: string | null;
  },
  action: string,
  targetId: string | undefined,
  reason: string | undefined,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    assertRecentReauth({
      authenticatedAt: ctx.authenticatedAt,
      authMethod: ctx.authMethod,
    });
  } catch (error) {
    if (ctx.userId) {
      const service = new AdminUserService(ctx.serverDB);
      await service.recordReauthDenied({
        action,
        actorUserId: ctx.userId,
        reason,
        targetId,
      });
    }
    throw error;
  }
  return run();
};

export const adminUsersRouter = router({
  list: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_READ))
    .input(adminUsersListInputSchema)
    .output(adminUsersListOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminUserService(ctx.serverDB);
      return service.list(input, { actorUserId: ctx.userId! });
    }),

  get: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_READ))
    .input(adminUsersGetInputSchema)
    .output(adminUsersGetOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.get(input.userId, { actorUserId: ctx.userId! });
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  getAuditTrail: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ))
    .input(adminUsersGetAuditTrailInputSchema)
    .output(adminUsersGetAuditTrailOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.getAuditTrail(input, { actorUserId: ctx.userId! });
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  ban: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .input(adminUsersBanInputSchema)
    .output(adminUsersBanOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withReauth(ctx as never, 'admin.users.ban', input.userId, input.reason, async () => {
        const service = new AdminUserService(ctx.serverDB);
        try {
          return await service.ban({ actorUserId: ctx.userId!, input });
        } catch (error) {
          return mapServiceError(error);
        }
      });
    }),

  unban: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .input(adminUsersUnbanInputSchema)
    .output(adminUsersUnbanOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withReauth(ctx as never, 'admin.users.unban', input.userId, input.reason, async () => {
        const service = new AdminUserService(ctx.serverDB);
        try {
          return await service.unban({ actorUserId: ctx.userId!, input });
        } catch (error) {
          return mapServiceError(error);
        }
      });
    }),

  revokeSessions: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_SESSION_REVOKE))
    .input(adminUsersRevokeSessionsInputSchema)
    .output(adminUsersRevokeSessionsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withReauth(
        ctx as never,
        'admin.users.revokeSessions',
        input.userId,
        input.reason,
        async () => {
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
        },
      );
    }),

  replaceGlobalRoles: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_ROLE_MANAGE))
    .input(adminUsersReplaceGlobalRolesInputSchema)
    .output(adminUsersReplaceGlobalRolesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withReauth(
        ctx as never,
        'admin.users.replaceGlobalRoles',
        input.userId,
        input.reason,
        async () => {
          const service = new AdminUserService(ctx.serverDB);
          try {
            return await service.replaceGlobalRoles({
              actorUserId: ctx.userId!,
              input,
            });
          } catch (error) {
            return mapServiceError(error);
          }
        },
      );
    }),
});

export type AdminUsersRouter = typeof adminUsersRouter;

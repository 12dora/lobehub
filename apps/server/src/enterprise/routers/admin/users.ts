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
  adminUsersBanOutputSchema,
  adminUsersCreateInputSchema,
  adminUsersCreateOutputSchema,
  adminUsersDeleteInputSchema,
  adminUsersDeleteOutputSchema,
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
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import {
  AdminUserEmailConflictError,
  AdminUserNotFoundError,
  AdminUserPasswordAuthDisabledError,
  AdminUserSelfBanError,
  AdminUserSelfDeleteError,
  AdminUserService,
  InvalidRetainedSessionError,
} from '../../services/adminUserService';
import { LastSuperAdminError } from '../../services/platformRbac';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

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
  if (error instanceof AdminUserSelfDeleteError) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { reason: 'self_delete' },
      httpCode: 'BAD_REQUEST',
    });
  }
  if (error instanceof AdminUserEmailConflictError) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { reason: error.reasonCode },
      httpCode: 'BAD_REQUEST',
    });
  }
  if (error instanceof AdminUserPasswordAuthDisabledError) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { reason: error.reasonCode },
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

/**
 * Typed dangerous-mutation reauth gate for admin.users.
 * Uses the shared helper so router-context fields stay compile-checked
 * (no `ctx as never` erasure).
 */
const assertUsersDangerousReauth = async (params: {
  action: string;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason?: string;
  serverDB: Parameters<typeof assertDangerousReauthWithAudit>[0]['serverDB'];
  targetId?: string;
}): Promise<void> =>
  assertDangerousReauthWithAudit({
    action: params.action,
    actorUserId: params.actorUserId,
    auditFailureLog: '[platform-audit] append failed',
    auditFailureMeta: {
      action: params.action,
      result: 'denied',
      targetType: 'user',
    },
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    reason: params.reason ?? null,
    serverDB: params.serverDB,
    targetId: params.targetId ?? null,
    targetType: 'user',
  });

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

  create: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_CREATE))
    .input(adminUsersCreateInputSchema)
    .output(adminUsersCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUsersDangerousReauth({
        action: 'admin.users.create',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.createUser({ actorUserId: ctx.userId!, input });
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  ban: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .input(adminUsersBanInputSchema)
    .output(adminUsersBanOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUsersDangerousReauth({
        action: 'admin.users.ban',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.userId,
      });
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.ban({ actorUserId: ctx.userId!, input });
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  unban: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .input(adminUsersUnbanInputSchema)
    .output(adminUsersUnbanOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUsersDangerousReauth({
        action: 'admin.users.unban',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.userId,
      });
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.unban({ actorUserId: ctx.userId!, input });
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  delete: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_DELETE))
    .input(adminUsersDeleteInputSchema)
    .output(adminUsersDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUsersDangerousReauth({
        action: 'admin.users.delete',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.userId,
      });
      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.deleteUser({ actorUserId: ctx.userId!, input });
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  revokeSessions: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_SESSION_REVOKE))
    .input(adminUsersRevokeSessionsInputSchema)
    .output(adminUsersRevokeSessionsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUsersDangerousReauth({
        action: 'admin.users.revokeSessions',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.userId,
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
    .output(adminUsersReplaceGlobalRolesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertUsersDangerousReauth({
        action: 'admin.users.replaceGlobalRoles',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.userId,
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

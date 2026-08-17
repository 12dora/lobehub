/**
 * Admin user global-role replacement.
 */
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { LastSuperAdminProtectionError } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';

import type { AdminUsersReplaceGlobalRolesInput } from '../../contracts/adminUsers';
import { LastSuperAdminError, PlatformRbacService } from '../platformRbac';
import { AdminUserNotFoundError, AdminUserSelfRoleChangeError } from './errors';
import { AdminUserSupport } from './support';

export class AdminUserRoleService extends AdminUserSupport {
  replaceGlobalRoles = async (params: {
    actorUserId: string;
    input: AdminUsersReplaceGlobalRolesInput;
  }) => {
    const { actorUserId, input } = params;

    if (input.userId === actorUserId) {
      await this.auditUserFailure({
        action: 'admin.users.replaceGlobalRoles',
        actorUserId,
        error: 'self_role_change',
        reason: input.reason,
        result: 'denied',
        targetId: input.userId,
      });
      throw new AdminUserSelfRoleChangeError();
    }

    // Permanent super_admin policy — reject any finite expiresAt with super_admin.
    if (input.expiresAt && input.roleNames.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN)) {
      await this.auditUserFailure({
        action: 'admin.users.replaceGlobalRoles',
        actorUserId,
        error: 'super_admin_expires_forbidden',
        reason: input.reason,
        result: 'denied',
        targetId: input.userId,
      });
      throw new Error(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    }

    const target = await this.users.findBanState(input.userId);
    if (!target) {
      await this.auditUserFailure({
        action: 'admin.users.replaceGlobalRoles',
        actorUserId,
        error: 'not_found',
        reason: input.reason,
        result: 'failure',
        targetId: input.userId,
      });
      throw new AdminUserNotFoundError();
    }

    try {
      // Role replace + both success audit rows in one outer transaction (R2-03 success atomicity).
      const result = await this.db.transaction(async (tx) => {
        const rbacService = new PlatformRbacService(tx as LobeChatDatabase);
        const replaced = await rbacService.replaceUserGlobalRoles({
          actorUserId,
          expiresAt: input.expiresAt,
          preserveRoleNames: input.preserveRoleNames,
          reason: input.reason,
          roleNames: input.roleNames,
          skipAudit: true,
          targetUserId: input.userId,
        });

        await this.appendAuditInDb(tx, {
          action: 'platform.roles.replace',
          actorUserId,
          afterDiff: {
            expiresAt: input.expiresAt?.toISOString() ?? null,
            roleNames: replaced.roleNames,
          },
          reason: input.reason,
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });

        await this.appendAuditInDb(tx, {
          action: 'admin.users.replaceGlobalRoles',
          actorUserId,
          afterDiff: {
            expiresAt: input.expiresAt?.toISOString() ?? null,
            roleNames: replaced.roleNames,
          },
          reason: input.reason,
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });

        return replaced;
      });

      return {
        expiresAt: input.expiresAt ?? null,
        roleNames: result.roleNames,
        userId: input.userId,
      };
    } catch (error) {
      if (
        error instanceof LastSuperAdminError ||
        error instanceof LastSuperAdminProtectionError ||
        (error instanceof Error &&
          (error.message === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED ||
            error.message === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT ||
            error.message === 'PLATFORM_INVALID_INPUT'))
      ) {
        await this.auditUserFailure({
          action: 'admin.users.replaceGlobalRoles',
          actorUserId,
          error:
            error instanceof Error &&
            error.message === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED
              ? 'permission_denied'
              : error instanceof LastSuperAdminError ||
                  error instanceof LastSuperAdminProtectionError
                ? 'last_super_admin'
                : 'invalid_input',
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
        });
      }
      if (error instanceof Error && error.message === 'PLATFORM_INVALID_INPUT') {
        throw new Error(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT, { cause: error });
      }
      throw error;
    }
  };
}

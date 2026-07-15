/**
 * Platform RBAC service: last-super-admin protection + global role assignment.
 */
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { getGlobalRoleIdsByName, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';

import { PlatformAuditService } from './platformAudit';

export class LastSuperAdminError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_LAST_SUPER_ADMIN;

  constructor(message = PLATFORM_ERROR_CODES.PLATFORM_LAST_SUPER_ADMIN) {
    super(message);
    this.name = 'LastSuperAdminError';
  }
}

export class PlatformRbacService {
  private readonly rbac: RbacModel;
  private readonly audit: PlatformAuditService;

  constructor(private readonly db: LobeChatDatabase | Transaction) {
    this.rbac = new RbacModel(db as LobeChatDatabase, 'system');
    this.audit = new PlatformAuditService(db);
  }

  listSystemRoles = async () => {
    await seedPlatformRoles(this.db as LobeChatDatabase);
    const names = Object.values(PLATFORM_SYSTEM_ROLES);
    const idMap = await getGlobalRoleIdsByName(this.db as LobeChatDatabase, names);
    return names.map((name) => ({
      id: idMap.get(name) ?? null,
      name,
      isEasyauthManaged: name !== PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
    }));
  };

  listUserGlobalRoles = async (userId: string) => {
    return this.rbac.getGlobalUserRoles(userId);
  };

  getUserGlobalPermissions = async (userId: string) => {
    return this.rbac.getGlobalUserPermissions(userId);
  };

  /**
   * Replace global roles for a user with last-super-admin protection.
   * Cannot remove the last active super_admin.
   * Cannot assign/remove super_admin via EasyAuth-managed paths without explicit allowSuperAdmin.
   */
  replaceUserGlobalRoles = async (params: {
    actorUserId: string;
    allowSuperAdmin?: boolean;
    reason: string;
    roleNames: string[];
    targetUserId: string;
  }): Promise<{ roleNames: string[] }> => {
    await seedPlatformRoles(this.db as LobeChatDatabase);

    const desired = [...new Set(params.roleNames)];
    if (!params.allowSuperAdmin) {
      // Keep existing super_admin if present; strip from desired when not allowed
      const isTargetSuper = await this.rbac.isGlobalSuperAdmin(params.targetUserId);
      const wantsSuper = desired.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
      if (wantsSuper && !isTargetSuper) {
        // only existing super_admins may grant super_admin
        const actorIsSuper = await this.rbac.isGlobalSuperAdmin(params.actorUserId);
        if (!actorIsSuper) {
          throw new Error(PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED);
        }
      }
    }

    // Last super admin protection when demoting
    const isTargetSuper = await this.rbac.isGlobalSuperAdmin(params.targetUserId);
    const keepsSuper = desired.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    if (isTargetSuper && !keepsSuper) {
      const count = await this.rbac.countActiveSuperAdmins();
      if (count <= 1) {
        throw new LastSuperAdminError();
      }
    }

    const idMap = await getGlobalRoleIdsByName(this.db as LobeChatDatabase, desired);
    const roleIds = desired
      .map((name) => idMap.get(name))
      .filter((id): id is string => Boolean(id));

    if (roleIds.length !== desired.length) {
      throw new Error(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    }

    await this.rbac.replaceGlobalUserRoles(params.targetUserId, roleIds);

    await this.audit.append({
      action: 'platform.roles.replace',
      actorUserId: params.actorUserId,
      afterDiff: { roleNames: desired },
      reason: params.reason,
      result: 'success',
      targetId: params.targetUserId,
      targetType: 'user',
    });

    return { roleNames: desired };
  };

  /**
   * Assert that banning / expiring / removing roles would not eliminate the last super admin.
   */
  assertNotLastSuperAdmin = async (targetUserId: string): Promise<void> => {
    const isTargetSuper = await this.rbac.isGlobalSuperAdmin(targetUserId);
    if (!isTargetSuper) return;
    const count = await this.rbac.countActiveSuperAdmins();
    if (count <= 1) {
      throw new LastSuperAdminError();
    }
  };
}

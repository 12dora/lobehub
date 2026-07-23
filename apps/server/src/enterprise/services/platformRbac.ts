/**
 * Platform RBAC service: last-super-admin protection + global role assignment.
 */
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { LastSuperAdminProtectionError, RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { getGlobalRoleIdsByName } from '@/database/utils/seedPlatformRoles';

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
    // Roles are seeded at bootstrap / ensurePlatformRbacSeeded — not on every request.
    const names = Object.values(PLATFORM_SYSTEM_ROLES);
    const idMap = await getGlobalRoleIdsByName(this.db as LobeChatDatabase, names);
    return names.map((name) => ({
      id: idMap.get(name) ?? null,
      // All system roles are managed via the admin RBAC console.
      isSystemRole: true,
      name,
    }));
  };

  listUserGlobalRoles = async (userId: string) => {
    return this.rbac.getGlobalUserRoles(userId);
  };

  getUserGlobalPermissions = async (userId: string) => {
    return this.rbac.getGlobalUserPermissions(userId);
  };

  /**
   * Replace global roles for a user.
   *
   * - Only super_admin may grant or revoke super_admin on others (matrix: user_admin
   *   cannot manage super_admin). Non-super actors keep target super_admin via preserve.
   * - Last active non-banned super_admin is protected inside the DB transaction (M1).
   */
  replaceUserGlobalRoles = async (params: {
    actorUserId: string;
    allowSuperAdmin?: boolean;
    /** Optional assignment expiry (written to rbac_user_roles.expires_at). */
    expiresAt?: Date | null;
    /** Role names whose existing grants are left untouched (expiry preserved). */
    preserveRoleNames?: string[];
    reason: string;
    roleNames: string[];
    /**
     * When true, skip platform.roles.replace audit (caller writes both audits
     * in the same outer transaction — M04 AdminUserService).
     */
    skipAudit?: boolean;
    targetUserId: string;
  }): Promise<{ expiresAt?: Date | null; roleNames: string[] }> => {
    const desired = [...new Set(params.roleNames)];

    // M04: super_admin is permanent — reject finite expiresAt with super_admin.
    if (params.expiresAt && desired.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN)) {
      throw new Error(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    }

    const isTargetSuper = await this.rbac.isGlobalSuperAdmin(params.targetUserId);
    const actorIsSuper = await this.rbac.isGlobalSuperAdmin(params.actorUserId);
    const wantsSuper = desired.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);

    if (!params.allowSuperAdmin) {
      // Grant super_admin: only existing super_admins may do so.
      if (wantsSuper && !isTargetSuper && !actorIsSuper) {
        throw new Error(PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED);
      }

      // Revoke / omit super_admin: only super_admins may demote (matrix: user_admin cannot).
      if (isTargetSuper && !wantsSuper && !actorIsSuper) {
        throw new Error(PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED);
      }
    }

    const idMap = await getGlobalRoleIdsByName(this.db as LobeChatDatabase, desired);
    const roleIds = desired
      .map((name) => idMap.get(name))
      .filter((id): id is string => Boolean(id));

    if (roleIds.length !== desired.length) {
      throw new Error(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    }

    try {
      await this.rbac.replaceGlobalUserRoles(params.targetUserId, roleIds, {
        expiresAt: params.expiresAt ?? null,
        preserveRoleNames: params.preserveRoleNames,
        protectLastSuperAdmin: true,
      });
    } catch (error) {
      if (error instanceof LastSuperAdminProtectionError) {
        throw new LastSuperAdminError();
      }
      throw error;
    }

    if (!params.skipAudit) {
      await this.audit.append({
        action: 'platform.roles.replace',
        actorUserId: params.actorUserId,
        afterDiff: {
          expiresAt: params.expiresAt?.toISOString() ?? null,
          roleNames: desired,
        },
        reason: params.reason,
        result: 'success',
        targetId: params.targetUserId,
        targetType: 'user',
      });
    }

    return { expiresAt: params.expiresAt ?? null, roleNames: desired };
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

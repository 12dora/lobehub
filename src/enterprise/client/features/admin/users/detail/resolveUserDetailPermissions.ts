import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { hasPermission } from '../utils';

/** The six permissions the detail body reads, resolved once from the granted list. */
export interface UserDetailPermissions {
  canBan: boolean;
  canDelete: boolean;
  canManageCredentials: boolean;
  canManageRoles: boolean;
  canReadAudit: boolean;
  canRevoke: boolean;
}

export const resolveUserDetailPermissions = (
  granted: readonly string[],
): UserDetailPermissions => ({
  canBan: hasPermission(granted, PLATFORM_PERMISSIONS.USER_BAN),
  canDelete: hasPermission(granted, PLATFORM_PERMISSIONS.USER_DELETE),
  canManageCredentials: hasPermission(granted, PLATFORM_PERMISSIONS.USER_CREDENTIAL_MANAGE),
  canManageRoles: hasPermission(granted, PLATFORM_PERMISSIONS.USER_ROLE_MANAGE),
  canReadAudit: hasPermission(granted, PLATFORM_PERMISSIONS.AUDIT_READ),
  canRevoke: hasPermission(granted, PLATFORM_PERMISSIONS.USER_SESSION_REVOKE),
});

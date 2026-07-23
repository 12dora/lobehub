/**
 * Grant the built-in platform_user role on first user create when the principal
 * has no global roles yet. Used from Better Auth user.create.after.
 *
 * Never throws — login / account creation must succeed even if RBAC seed fails.
 */
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import type { LobeChatDatabase } from '../../type';
import * as seedPlatformRoles from '../../utils/seedPlatformRoles';
import { RbacModel } from '../rbac';

/**
 * Ensure platform RBAC seed exists (roles + permissions). Local alias for the
 * server bootstrap helper so database-layer hooks stay path-boundary safe.
 */
export const ensurePlatformRbacSeededLocal = async (db: LobeChatDatabase): Promise<void> => {
  await seedPlatformRoles.ensurePlatformPermissionsExist(db);
  await seedPlatformRoles.seedPlatformRoles(db);
};

/**
 * If the user has zero global roles, append `platform_user`.
 * Does not replace existing roles and never touches super_admin grants.
 */
export const ensureDefaultPlatformUserRole = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<void> => {
  try {
    if (!userId) return;

    await ensurePlatformRbacSeededLocal(db);

    const rbac = new RbacModel(db, userId);
    const globalRoles = await rbac.getGlobalUserRoles(userId);
    if (globalRoles.length > 0) return;

    const idMap = await seedPlatformRoles.getGlobalRoleIdsByName(db, [
      PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    ]);
    if (!idMap.get(PLATFORM_SYSTEM_ROLES.PLATFORM_USER)) {
      // Seed should have created it; bail quietly if still missing.
      return;
    }

    await seedPlatformRoles.assignGlobalPlatformRole(db, {
      roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
      userId,
    });
  } catch (error) {
    // Never block account creation / login.
    console.error('[ensureDefaultPlatformUserRole] failed (non-blocking)', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      userId,
    });
  }
};

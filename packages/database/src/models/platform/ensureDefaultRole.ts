/**
 * Grant the built-in platform_user role on first user create when the principal
 * has no global roles yet. Used from Better Auth user.create.after and
 * session.create.before (idempotent repair path).
 *
 * Never throws — login / account creation must succeed even if RBAC seed fails.
 * Callers that care about eventual consistency inspect the typed result.
 */
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import type { LobeChatDatabase } from '../../type';
import * as seedPlatformRoles from '../../utils/seedPlatformRoles';
import { RbacModel } from '../rbac';

/** Outcome of a non-blocking default-role provisioning attempt. */
export type EnsureDefaultPlatformUserRoleResult =
  | { status: 'assigned' }
  | { status: 'alreadyAssigned' }
  | { status: 'skipped' }
  | {
      /** Stable category for metrics / logs — never includes stack or SQL text. */
      errorCategory: string;
      status: 'retryRequired';
    };

/**
 * Ensure platform RBAC seed exists (roles + permissions). Local alias for the
 * server bootstrap helper so database-layer hooks stay path-boundary safe.
 */
export const ensurePlatformRbacSeededLocal = async (db: LobeChatDatabase): Promise<void> => {
  await seedPlatformRoles.ensurePlatformPermissionsExist(db);
  await seedPlatformRoles.seedPlatformRoles(db);
};

const classifyProvisionError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'UnknownError';
  const name = error.name || 'Error';
  // Coarse categories only — avoid leaking constraint/detail strings into metrics.
  if (/timeout|ECONN|connection|network/i.test(error.message)) return 'TransientDbError';
  if (/unique|duplicate|conflict/i.test(error.message)) return 'ConflictError';
  return name;
};

/**
 * If the user has zero global roles, append `platform_user`.
 * Does not replace existing roles and never touches super_admin grants.
 *
 * Returns a typed result so session hooks can retry until assignment succeeds.
 */
export const ensureDefaultPlatformUserRole = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<EnsureDefaultPlatformUserRoleResult> => {
  try {
    if (!userId) return { status: 'skipped' };

    // Cheap read first (DB-004 rework): most logins already have a global role.
    // Never open the platform-role seed transaction on the hot session path.
    const rbac = new RbacModel(db, userId);
    const globalRoles = await rbac.getGlobalUserRoles(userId);
    if (globalRoles.length > 0) return { status: 'alreadyAssigned' };

    // Rare repair path: user has zero global roles (first create, or prior seed failure).
    await ensurePlatformRbacSeededLocal(db);

    const idMap = await seedPlatformRoles.getGlobalRoleIdsByName(db, [
      PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    ]);
    if (!idMap.get(PLATFORM_SYSTEM_ROLES.PLATFORM_USER)) {
      // Seed should have created it; signal retry so a later session can repair.
      console.error('[ensureDefaultPlatformUserRole] platform_user role missing after seed', {
        errorCategory: 'RoleMissingAfterSeed',
        userId,
      });
      return { errorCategory: 'RoleMissingAfterSeed', status: 'retryRequired' };
    }

    await seedPlatformRoles.assignGlobalPlatformRole(db, {
      roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
      userId,
    });
    return { status: 'assigned' };
  } catch (error) {
    // Never block account creation / login.
    const errorCategory = classifyProvisionError(error);
    console.error('[ensureDefaultPlatformUserRole] failed (non-blocking)', {
      errorCategory,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      userId,
    });
    return { errorCategory, status: 'retryRequired' };
  }
};

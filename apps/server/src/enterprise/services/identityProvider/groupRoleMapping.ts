import { PLATFORM_SYSTEM_ROLES, type PlatformSystemRoleName } from '@/const/platform/roles';
import { RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';
import * as seedPlatformRoles from '@/database/utils/seedPlatformRoles';

/** Roles that may never be granted via IdP group mapping (break-glass only). */
const FORBIDDEN_MAPPED_ROLES = new Set<string>([PLATFORM_SYSTEM_ROLES.SUPER_ADMIN]);

const KNOWN_PLATFORM_ROLES = new Set<string>(Object.values(PLATFORM_SYSTEM_ROLES));

/**
 * Extract group names from standard OIDC/Authentik claim shapes.
 * Supports `groups` as string[] | string, and nested `group` / `roles`.
 */
export const extractIdentityProviderGroups = (claims: Record<string, unknown>): string[] => {
  const raw = claims.groups ?? claims.group ?? claims.roles;
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  if (!Array.isArray(raw)) return [];
  const groups: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) groups.push(item.trim());
  }
  return [...new Set(groups)];
};

/**
 * Map IdP group names → platform role names.
 * Unknown / forbidden role targets are dropped (fail closed for super_admin).
 * Empty mapping → no mapped roles (caller keeps default platform_user).
 */
export const resolveMappedPlatformRoles = (input: {
  groups: readonly string[];
  groupRoleMapping: Record<string, string>;
}): PlatformSystemRoleName[] => {
  const roles = new Set<string>();
  for (const group of input.groups) {
    const mapped = input.groupRoleMapping[group];
    if (!mapped) continue;
    if (FORBIDDEN_MAPPED_ROLES.has(mapped)) continue;
    if (!KNOWN_PLATFORM_ROLES.has(mapped)) continue;
    roles.add(mapped);
  }
  // Always retain baseline authenticated identity when any mapping is configured or not.
  roles.add(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
  return [...roles] as PlatformSystemRoleName[];
};

/**
 * Reconcile global platform roles for a user from IdP groups.
 * - Never grants super_admin via mapping
 * - Preserves an existing super_admin grant (break-glass)
 * - Replaces other global roles with the mapped set (+ platform_user)
 * Non-blocking: logs and returns on failure so login still succeeds.
 */
export const applyGroupRoleMappingToUser = async (input: {
  db: LobeChatDatabase;
  groups: readonly string[];
  groupRoleMapping: Record<string, string>;
  userId: string;
}): Promise<{ applied: string[]; skipped: boolean }> => {
  try {
    if (!input.userId) return { applied: [], skipped: true };
    // No mapping configured → do not touch roles (default path owns platform_user).
    if (Object.keys(input.groupRoleMapping).length === 0) {
      return { applied: [], skipped: true };
    }

    const desired = resolveMappedPlatformRoles({
      groupRoleMapping: input.groupRoleMapping,
      groups: input.groups,
    });

    await seedPlatformRoles.ensurePlatformPermissionsExist(input.db);
    await seedPlatformRoles.seedPlatformRoles(input.db);

    const rbac = new RbacModel(input.db, input.userId);
    const existing = await rbac.getGlobalUserRoles(input.userId);
    const isSuper = existing.some((role) => role.name === PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);

    const finalNames = isSuper
      ? [...new Set([...desired, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN])]
      : desired;

    const idMap = await seedPlatformRoles.getGlobalRoleIdsByName(input.db, finalNames);
    const roleIds = finalNames
      .map((name) => idMap.get(name))
      .filter((id): id is string => Boolean(id));
    if (roleIds.length !== finalNames.length) {
      console.error('[identityProvider.groupRoleMapping] role seed incomplete', {
        desired: finalNames,
      });
      return { applied: [], skipped: true };
    }

    await rbac.replaceGlobalUserRoles(input.userId, roleIds, {
      expiresAt: null,
      preserveRoleNames: isSuper ? [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN] : [],
      protectLastSuperAdmin: true,
    });
    return { applied: finalNames, skipped: false };
  } catch (error) {
    console.error('[identityProvider.groupRoleMapping] apply failed (non-blocking)', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      userId: input.userId,
    });
    return { applied: [], skipped: true };
  }
};

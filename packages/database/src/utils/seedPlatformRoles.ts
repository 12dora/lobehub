/**
 * Idempotent seed of global platform roles + platform_* permissions (M02).
 * Roles have `workspace_id IS NULL`. Safe to re-run.
 *
 * Call from bootstrap / startup only — not on request hot paths (M3).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { PLATFORM_PERMISSION_LIST } from '@/const/platform/permissions';
import {
  PLATFORM_ROLE_DESCRIPTIONS,
  PLATFORM_ROLE_DISPLAY_NAMES,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_SYSTEM_ROLES,
  type PlatformSystemRoleName,
} from '@/const/platform/roles';

import { permissions, rolePermissions, roles, userRoles } from '../schemas/rbac';
import type { LobeChatDatabase, Transaction } from '../type';

type Db = LobeChatDatabase | Transaction;

const codeToCategory = (code: string): string => {
  const parts = code.split(':');
  return parts[0] || 'platform';
};

const codeToName = (code: string): string =>
  code
    .replace(/:all$/, '')
    .split(/[:_]/)
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(' ');

/**
 * Ensure every platform permission code exists in `rbac_permissions`.
 */
export const ensurePlatformPermissionsExist = async (db: Db): Promise<Map<string, string>> => {
  const codeList = [...PLATFORM_PERMISSION_LIST];
  if (codeList.length === 0) return new Map();

  const existing = await db
    .select({ code: permissions.code, id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, codeList));

  const existingCodes = new Set(existing.map((p) => p.code));
  const missing = codeList.filter((code) => !existingCodes.has(code));

  if (missing.length > 0) {
    await db
      .insert(permissions)
      .values(
        missing.map((code) => ({
          category: codeToCategory(code),
          code,
          description: `Platform permission ${code}`,
          isActive: true,
          name: codeToName(code),
        })),
      )
      .onConflictDoNothing({ target: permissions.code });
  }

  const all = await db
    .select({ code: permissions.code, id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, codeList));

  return new Map(all.map((p) => [p.code, p.id] as const));
};

const syncRolePermissions = async (
  db: Db,
  roleId: string,
  desiredPermissionIds: string[],
): Promise<void> => {
  const existing = await db
    .select({ permissionId: rolePermissions.permissionId })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));

  const existingSet = new Set(existing.map((r) => r.permissionId));
  const desiredSet = new Set(desiredPermissionIds);

  const same =
    existingSet.size === desiredSet.size && [...desiredSet].every((id) => existingSet.has(id));
  if (same) return;

  // Diff-only rewrite inside caller's transaction when provided.
  await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  if (desiredPermissionIds.length > 0) {
    await db
      .insert(rolePermissions)
      .values(
        desiredPermissionIds.map((permissionId) => ({
          permissionId,
          roleId,
        })),
      )
      .onConflictDoNothing();
  }
};

const upsertGlobalRole = async (
  db: Db,
  roleName: PlatformSystemRoleName,
  permissionIdByCode: Map<string, string>,
): Promise<string> => {
  const existing = await db.query.roles.findFirst({
    where: and(eq(roles.name, roleName), isNull(roles.workspaceId)),
  });

  let roleId: string;
  if (existing) {
    roleId = existing.id;
    await db
      .update(roles)
      .set({
        description: PLATFORM_ROLE_DESCRIPTIONS[roleName],
        displayName: PLATFORM_ROLE_DISPLAY_NAMES[roleName],
        isActive: true,
        isSystem: true,
      })
      .where(eq(roles.id, roleId));
  } else {
    const [inserted] = await db
      .insert(roles)
      .values({
        description: PLATFORM_ROLE_DESCRIPTIONS[roleName],
        displayName: PLATFORM_ROLE_DISPLAY_NAMES[roleName],
        isActive: true,
        isSystem: true,
        name: roleName,
        workspaceId: null,
      })
      .returning({ id: roles.id });
    roleId = inserted.id;
  }

  const desiredCodes = PLATFORM_ROLE_PERMISSIONS[roleName];
  const desiredPermissionIds = desiredCodes
    .map((code) => permissionIdByCode.get(code))
    .filter((id): id is string => Boolean(id));

  await syncRolePermissions(db, roleId, desiredPermissionIds);
  return roleId;
};

/**
 * Seed all platform system roles (global) and their permission packages.
 * Wrapped in a single transaction. Returns role name → role id.
 *
 * Prefer calling via `ensurePlatformRbacSeeded` at process start / bootstrap,
 * not on every admin/sync request.
 */
export const seedPlatformRoles = async (db: Db): Promise<Map<PlatformSystemRoleName, string>> => {
  const run = async (tx: Db) => {
    const permissionIdByCode = await ensurePlatformPermissionsExist(tx);
    const roleIds = new Map<PlatformSystemRoleName, string>();

    for (const roleName of Object.values(PLATFORM_SYSTEM_ROLES)) {
      const id = await upsertGlobalRole(tx, roleName, permissionIdByCode);
      roleIds.set(roleName, id);
    }

    return roleIds;
  };

  // Prefer real transaction when available on LobeChatDatabase.
  if (typeof (db as LobeChatDatabase).transaction === 'function') {
    return (db as LobeChatDatabase).transaction(async (tx) => run(tx));
  }
  return run(db);
};

/**
 * Grant a global platform system role to a user (idempotent).
 * Does not touch workspace roles. Seeds only if the role row is missing.
 */
export const assignGlobalPlatformRole = async (
  db: Db,
  params: {
    expiresAt?: Date | null;
    roleName: PlatformSystemRoleName;
    userId: string;
  },
): Promise<void> => {
  let role = await db.query.roles.findFirst({
    where: and(eq(roles.name, params.roleName), isNull(roles.workspaceId)),
  });
  if (!role) {
    await seedPlatformRoles(db);
    role = await db.query.roles.findFirst({
      where: and(eq(roles.name, params.roleName), isNull(roles.workspaceId)),
    });
  }
  if (!role) {
    throw new Error(`Platform role ${params.roleName} not found after seed`);
  }

  await db
    .insert(userRoles)
    .values({
      expiresAt: params.expiresAt ?? null,
      roleId: role.id,
      userId: params.userId,
      workspaceId: null,
    })
    .onConflictDoNothing();
};

/**
 * Look up global role ids by name (no seed).
 */
export const getGlobalRoleIdsByName = async (
  db: Db,
  roleNames: string[],
): Promise<Map<string, string>> => {
  if (roleNames.length === 0) return new Map();

  const rows = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(
      and(inArray(roles.name, roleNames), isNull(roles.workspaceId), eq(roles.isActive, true)),
    );

  return new Map(rows.map((r) => [r.name, r.id] as const));
};

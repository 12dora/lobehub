/**
 * Global DB digest snapshot for suite before/after equality.
 */
import { createHash } from 'node:crypto';

import { Pool } from 'pg';

import { MANAGED_RESOURCES, PLATFORM_PERMISSIONS, PLATFORM_ROLES } from './fixtureCatalog';
import type { GlobalDbDigest } from './types';

export const snapshotGlobalDbDigest = async (databaseUrl: string): Promise<GlobalDbDigest> => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const perms = await pool.query(
      `SELECT id, code FROM rbac_permissions WHERE code = ANY($1::text[]) ORDER BY code`,
      [PLATFORM_PERMISSIONS],
    );
    const roles = await pool.query(
      `SELECT id, name FROM rbac_roles WHERE workspace_id IS NULL AND name = ANY($1::text[]) ORDER BY name`,
      [PLATFORM_ROLES],
    );
    const rolePerms = await pool.query(
      `SELECT r.id AS role_id, r.name AS role_name, p.id AS permission_id, p.code AS permission_code
         FROM rbac_role_permissions rp
         JOIN rbac_roles r ON r.id = rp.role_id
         JOIN rbac_permissions p ON p.id = rp.permission_id
        WHERE r.workspace_id IS NULL AND r.name = ANY($1::text[])
        ORDER BY r.name, p.code`,
      [PLATFORM_ROLES],
    );
    const policies = await pool.query(
      `SELECT id, resource, status, revision, enforcement, config::text AS config
         FROM platform_managed_resource_policies
        WHERE resource = ANY($1::text[])
        ORDER BY resource`,
      [MANAGED_RESOURCES],
    );
    return {
      managedPolicies: policies.rows.map((row) => ({
        config: String(row.config ?? ''),
        enforcement: String(row.enforcement ?? ''),
        id: String(row.id),
        resource: String(row.resource),
        revision: Number(row.revision),
        status: String(row.status),
      })),
      platformPermissions: perms.rows.map((row) => ({
        code: String(row.code),
        id: String(row.id),
      })),
      platformRolePermissions: rolePerms.rows.map((row) => ({
        permissionCode: String(row.permission_code),
        permissionId: String(row.permission_id),
        roleId: String(row.role_id),
        roleName: String(row.role_name),
      })),
      platformRoles: roles.rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
      })),
    };
  } finally {
    await pool.end();
  }
};

export const digestFingerprint = (digest: GlobalDbDigest): string =>
  createHash('sha256').update(JSON.stringify(digest)).digest('hex');

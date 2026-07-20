import { createHash, randomBytes, randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

export interface SuitePrincipal {
  accountId: string;
  email: string;
  fullName: string;
  id: string;
  password: string;
  roleLabel: 'ordinary' | 'owner' | 'super_admin' | 'auditor';
  username: string;
}

export interface SuiteSeed {
  auditor: SuitePrincipal;
  namespace: string;
  ordinary: SuitePrincipal;
  owner: SuitePrincipal;
  superAdmin: SuitePrincipal;
  workspaceId: string;
  workspaceSlug: string;
}

export interface ManagedPolicyRow {
  config: string;
  enforcement: string;
  id: string;
  resource: string;
  revision: number;
  status: string;
}

export interface RolePermissionLink {
  permissionCode: string;
  permissionId: string;
  roleId: string;
  roleName: string;
}

/**
 * Canonical suite-written permission row — every stored column including
 * default/generated timestamps. Timestamps are captured as ISO strings from DB.
 */
export interface PlatformPermissionRow {
  category: string;
  code: string;
  createdAt: string;
  description: string;
  fingerprint: string;
  id: string;
  isActive: boolean;
  name: string;
  updatedAt: string;
}

/**
 * Canonical suite-written platform role row — every stored column including
 * metadata (stable JSON) and timestamps.
 */
export interface PlatformRoleRow {
  createdAt: string;
  description: string;
  displayName: string;
  fingerprint: string;
  id: string;
  isActive: boolean;
  isSystem: boolean;
  /** Canonical JSON text (jsonb_strip_nulls + sorted keys via JSON.stringify of parsed object). */
  metadata: string;
  name: string;
  updatedAt: string;
  /** Always null for platform roles owned by this suite. */
  workspaceId: null;
}

/** Optional hooks for deterministic concurrency tests (barriers after FOR UPDATE). */
export interface CasRestoreHooks {
  afterPermissionLocked?: (permissionId: string) => Promise<void>;
  afterRoleLocked?: (roleId: string) => Promise<void>;
}

/** Full global digest used for before/after equality. */
export interface GlobalDbDigest {
  managedPolicies: ManagedPolicyRow[];
  platformPermissions: Array<{ code: string; id: string }>;
  platformRolePermissions: RolePermissionLink[];
  platformRoles: Array<{ id: string; name: string }>;
}

/**
 * Suite-written after-manifest + created-row ownership for true CAS restore.
 * Every created row/link stores full suite-written after state + fingerprint.
 * Delete only when current still equals that after state; foreign deps → conflict.
 */
export interface SuiteGlobalWriteManifest {
  /** Full global snapshot immediately after suite seed commit. */
  after: GlobalDbDigest;
  before: GlobalDbDigest;
  /** Suite-created permissions with complete after-state + fingerprint. */
  createdPermissions: PlatformPermissionRow[];
  /** Suite-created managed policies with full after row. */
  createdPolicies: ManagedPolicyRow[];
  /** Suite-created role↔permission links only (never wipe foreign links). */
  createdRolePermissionKeys: Array<{
    fingerprint: string;
    permissionCode: string;
    permissionId: string;
    roleId: string;
    roleName: string;
  }>;
  /** Suite-created platform roles with complete after-state + fingerprint. */
  createdRoles: PlatformRoleRow[];
  /** Policies that existed before and were mutated by this suite (CAS target). */
  mutatedPolicies: Array<{
    after: ManagedPolicyRow;
    before: ManagedPolicyRow;
  }>;
}

const MANAGED_RESOURCES = ['agents', 'aiModels', 'aiProviders', 'connectors', 'skills'] as const;

/** Mirrors packages/const/src/platform/permissions.ts PLATFORM_PERMISSION_LIST. */
const PLATFORM_PERMISSIONS = [
  'platform_admin:access:all',
  'platform_user:read:all',
  'platform_user:update:all',
  'platform_user:ban:all',
  'platform_user:session_revoke:all',
  'platform_user:role_manage:all',
  'platform_settings:read:all',
  'platform_settings:update:all',
  'platform_settings:publish:all',
  'platform_policy:read:all',
  'platform_policy:update:all',
  'platform_policy:publish:all',
  'platform_ai_provider:read:all',
  'platform_ai_provider:create:all',
  'platform_ai_provider:update:all',
  'platform_ai_provider:delete:all',
  'platform_ai_provider:test:all',
  'platform_ai_provider:publish:all',
  'platform_ai_model:read:all',
  'platform_ai_model:create:all',
  'platform_ai_model:update:all',
  'platform_ai_model:delete:all',
  'platform_ai_model:publish:all',
  'platform_skill:read:all',
  'platform_skill:create:all',
  'platform_skill:update:all',
  'platform_skill:delete:all',
  'platform_skill:publish:all',
  'platform_connector:read:all',
  'platform_connector:create:all',
  'platform_connector:update:all',
  'platform_connector:delete:all',
  'platform_connector:test:all',
  'platform_connector:publish:all',
  'platform_agent:read:all',
  'platform_agent:create:all',
  'platform_agent:update:all',
  'platform_agent:delete:all',
  'platform_agent:publish:all',
  'platform_agent:assign:all',
  'platform_identity:read:all',
  'platform_identity:create:all',
  'platform_identity:update:all',
  'platform_identity:delete:all',
  'platform_identity:test:all',
  'platform_identity:publish:all',
  'platform_branding:read:all',
  'platform_branding:update:all',
  'platform_branding:publish:all',
  'platform_audit:read:all',
  'platform_audit:export:all',
  'platform_system:read:all',
  'platform_system:operate:all',
  'platform_oidc:publish:all',
  'platform_role:read:all',
  'platform_role:update:all',
] as const;

const PLATFORM_ROLES = [
  'super_admin',
  'user_admin',
  'ai_admin',
  'identity_admin',
  'auditor',
  'platform_user',
] as const;

const READ_ONLY_CODES = PLATFORM_PERMISSIONS.filter(
  (code) =>
    code.includes(':read:') || code.includes(':export:') || code === 'platform_admin:access:all',
);

const ROLE_PERMISSION_MAP: Record<(typeof PLATFORM_ROLES)[number], readonly string[]> = {
  super_admin: PLATFORM_PERMISSIONS,
  user_admin: [
    'platform_admin:access:all',
    'platform_user:read:all',
    'platform_user:update:all',
    'platform_user:ban:all',
    'platform_user:session_revoke:all',
    'platform_user:role_manage:all',
    'platform_role:read:all',
    'platform_role:update:all',
    'platform_audit:read:all',
  ],
  ai_admin: [
    'platform_admin:access:all',
    'platform_user:read:all',
    'platform_settings:read:all',
    'platform_policy:read:all',
    'platform_policy:update:all',
    'platform_policy:publish:all',
    'platform_ai_provider:read:all',
    'platform_ai_provider:create:all',
    'platform_ai_provider:update:all',
    'platform_ai_provider:delete:all',
    'platform_ai_provider:test:all',
    'platform_ai_provider:publish:all',
    'platform_ai_model:read:all',
    'platform_ai_model:create:all',
    'platform_ai_model:update:all',
    'platform_ai_model:delete:all',
    'platform_ai_model:publish:all',
    'platform_skill:read:all',
    'platform_skill:create:all',
    'platform_skill:update:all',
    'platform_skill:delete:all',
    'platform_skill:publish:all',
    'platform_connector:read:all',
    'platform_connector:create:all',
    'platform_connector:update:all',
    'platform_connector:delete:all',
    'platform_connector:test:all',
    'platform_connector:publish:all',
    'platform_agent:read:all',
    'platform_agent:create:all',
    'platform_agent:update:all',
    'platform_agent:delete:all',
    'platform_agent:publish:all',
    'platform_agent:assign:all',
    'platform_audit:read:all',
  ],
  identity_admin: [
    'platform_admin:access:all',
    'platform_user:read:all',
    'platform_identity:read:all',
    'platform_identity:create:all',
    'platform_identity:update:all',
    'platform_identity:delete:all',
    'platform_identity:test:all',
    'platform_identity:publish:all',
    'platform_oidc:publish:all',
    'platform_branding:read:all',
    'platform_branding:update:all',
    'platform_branding:publish:all',
    'platform_audit:read:all',
  ],
  auditor: [
    ...new Set([
      ...READ_ONLY_CODES,
      'platform_audit:read:all',
      'platform_audit:export:all',
      'platform_role:read:all',
      'platform_system:read:all',
    ]),
  ],
  platform_user: [],
};

const nano = (bytes = 6) => randomBytes(bytes).toString('hex');

const makePrincipal = (
  namespace: string,
  roleLabel: SuitePrincipal['roleLabel'],
  password: string,
): SuitePrincipal => {
  const tag = `${namespace}_${roleLabel}`;
  return {
    accountId: `acct_${tag}`.slice(0, 64),
    email: `e2e.${tag}@example.test`,
    fullName: `E2E ${roleLabel}`,
    id: `user_${tag}`.slice(0, 64),
    password,
    roleLabel,
    username: `e2e_${tag}`.slice(0, 48),
  };
};

export const createSuiteNamespace = (): string =>
  `m15q04_${Date.now().toString(36)}_${nano(3)}`.replaceAll(/\W/g, '_');

const policyFingerprint = (row: ManagedPolicyRow): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        config: row.config,
        enforcement: row.enforcement,
        id: row.id,
        resource: row.resource,
        revision: row.revision,
        status: row.status,
      }),
    )
    .digest('hex');

/** Stable ISO for timestamptz values from node-pg Date or string. */
const tsIso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return value;
  }
  return String(value ?? '');
};

/** Canonical JSON for jsonb metadata (sorted keys, null-stripped empty → {}). */
export const canonicalizeJson = (value: unknown): string => {
  const normalize = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(normalize);
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        const n = normalize(obj[key]);
        if (n !== null && n !== undefined) out[key] = n;
      }
      return out;
    }
    return v;
  };
  const n = normalize(value);
  return JSON.stringify(n === null ? {} : n);
};

/** Canonical permission after-state fingerprint (every stored column). */
export const permissionFingerprint = (row: {
  category: string;
  code: string;
  createdAt: string;
  description: string;
  id: string;
  isActive: boolean;
  name: string;
  updatedAt: string;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        category: row.category,
        code: row.code,
        createdAt: row.createdAt,
        description: row.description,
        id: row.id,
        isActive: row.isActive,
        name: row.name,
        updatedAt: row.updatedAt,
      }),
    )
    .digest('hex');

/** Canonical role after-state fingerprint (every stored column). */
export const roleFingerprint = (row: {
  createdAt: string;
  description: string;
  displayName: string;
  id: string;
  isActive: boolean;
  isSystem: boolean;
  metadata: string;
  name: string;
  updatedAt: string;
  workspaceId: null | string;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        createdAt: row.createdAt,
        description: row.description,
        displayName: row.displayName,
        id: row.id,
        isActive: row.isActive,
        isSystem: row.isSystem,
        metadata: row.metadata,
        name: row.name,
        updatedAt: row.updatedAt,
        workspaceId: row.workspaceId,
      }),
    )
    .digest('hex');

const linkFingerprint = (row: { permissionId: string; roleId: string }): string =>
  createHash('sha256')
    .update(JSON.stringify({ permissionId: row.permissionId, roleId: row.roleId }))
    .digest('hex');

const mapPermissionRow = (row: Record<string, unknown>): PlatformPermissionRow => {
  const base = {
    category: String(row.category ?? ''),
    code: String(row.code),
    createdAt: tsIso(row.created_at ?? row.createdAt),
    description: row.description == null ? '' : String(row.description),
    id: String(row.id),
    isActive: Boolean(row.is_active ?? row.isActive ?? true),
    name: String(row.name ?? row.code),
    updatedAt: tsIso(row.updated_at ?? row.updatedAt),
  };
  return { ...base, fingerprint: permissionFingerprint(base) };
};

const mapRoleRow = (row: Record<string, unknown>): PlatformRoleRow => {
  let metadataRaw: unknown = row.metadata;
  if (typeof metadataRaw === 'string') {
    try {
      metadataRaw = JSON.parse(metadataRaw);
    } catch {
      metadataRaw = {};
    }
  }
  const base = {
    createdAt: tsIso(row.created_at ?? row.createdAt),
    description: row.description == null ? '' : String(row.description),
    displayName: String(row.display_name ?? row.displayName ?? row.name),
    id: String(row.id),
    isActive: Boolean(row.is_active ?? row.isActive ?? true),
    isSystem: Boolean(row.is_system ?? row.isSystem ?? true),
    metadata: canonicalizeJson(metadataRaw ?? {}),
    name: String(row.name),
    updatedAt: tsIso(row.updated_at ?? row.updatedAt),
    workspaceId: null as null,
  };
  return { ...base, fingerprint: roleFingerprint(base) };
};

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

/**
 * True CAS restore:
 * - Mutated existing policies: UPDATE only when current fingerprint equals suite-written after.
 * - Suite-created rows/links: DELETE only if current full state equals suite-written after fingerprint.
 * - Foreign concurrent deps on created roles/permissions → refuse restore (never wipe all links).
 */
export const casRestoreGlobalDb = async (
  databaseUrl: string,
  manifest: SuiteGlobalWriteManifest,
  hooks?: CasRestoreHooks,
): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl });
  const suiteLinkKeys = new Set(
    manifest.createdRolePermissionKeys.map((l) => `${l.roleId}|${l.permissionId}`),
  );
  try {
    await pool.query('BEGIN');

    // 1) CAS-restore mutated existing policies
    for (const { before, after } of manifest.mutatedPolicies) {
      const current = await pool.query(
        `SELECT id, resource, status, revision, enforcement, config::text AS config
           FROM platform_managed_resource_policies WHERE resource = $1 LIMIT 1`,
        [after.resource],
      );
      if (!current.rows[0]) {
        throw new Error(
          `CAS restore conflict: policy ${after.resource} missing (expected suite-written or before)`,
        );
      }
      const cur: ManagedPolicyRow = {
        config: String(current.rows[0].config ?? ''),
        enforcement: String(current.rows[0].enforcement ?? ''),
        id: String(current.rows[0].id),
        resource: String(current.rows[0].resource),
        revision: Number(current.rows[0].revision),
        status: String(current.rows[0].status),
      };
      const curFp = policyFingerprint(cur);
      const afterFp = policyFingerprint(after);
      const beforeFp = policyFingerprint(before);
      if (curFp === beforeFp) {
        continue;
      }
      if (curFp !== afterFp) {
        throw new Error(
          `CAS restore conflict on policy ${after.resource}: current fingerprint diverged from suite-written after (refusing overwrite)`,
        );
      }
      const updated = await pool.query(
        `UPDATE platform_managed_resource_policies
            SET status = $2,
                revision = $3,
                enforcement = $4,
                config = $5::jsonb,
                updated_at = NOW()
          WHERE resource = $1
            AND revision = $6
            AND enforcement = $7
            AND status = $8
            AND config::text = $9
          RETURNING id`,
        [
          after.resource,
          before.status,
          before.revision,
          before.enforcement,
          before.config,
          after.revision,
          after.enforcement,
          after.status,
          after.config,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `CAS restore conflict on policy ${after.resource}: WHERE match failed (concurrent change)`,
        );
      }
    }

    // 2) Delete suite-created policies only when after-state still matches
    for (const policy of manifest.createdPolicies) {
      const current = await pool.query(
        `SELECT id, resource, status, revision, enforcement, config::text AS config
           FROM platform_managed_resource_policies WHERE id = $1 LIMIT 1`,
        [policy.id],
      );
      if (!current.rows[0]) continue; // already gone
      const cur: ManagedPolicyRow = {
        config: String(current.rows[0].config ?? ''),
        enforcement: String(current.rows[0].enforcement ?? ''),
        id: String(current.rows[0].id),
        resource: String(current.rows[0].resource),
        revision: Number(current.rows[0].revision),
        status: String(current.rows[0].status),
      };
      if (policyFingerprint(cur) !== policyFingerprint(policy)) {
        throw new Error(
          `CAS restore conflict: created policy ${policy.id} (${policy.resource}) after-state drifted — refuse delete`,
        );
      }
      const deleted = await pool.query(
        `DELETE FROM platform_managed_resource_policies
          WHERE id = $1 AND revision = $2 AND enforcement = $3 AND status = $4 AND config::text = $5
          RETURNING id`,
        [policy.id, policy.revision, policy.enforcement, policy.status, policy.config],
      );
      if (deleted.rowCount !== 1) {
        throw new Error(
          `CAS restore conflict: created policy ${policy.id} concurrent change during delete`,
        );
      }
    }

    // 3) Delete suite-created role_permission links only (exact keys + fingerprint)
    for (const link of manifest.createdRolePermissionKeys) {
      const current = await pool.query(
        `SELECT role_id, permission_id FROM rbac_role_permissions
          WHERE role_id = $1 AND permission_id = $2 LIMIT 1`,
        [link.roleId, link.permissionId],
      );
      if (!current.rows[0]) continue;
      if (linkFingerprint(link) !== link.fingerprint) {
        throw new Error(
          `CAS restore conflict: created role_permission ${link.roleId}|${link.permissionId} fingerprint mismatch`,
        );
      }
      await pool.query(
        `DELETE FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
        [link.roleId, link.permissionId],
      );
    }

    // 4) Delete suite-created platform roles — FOR UPDATE holds parent through checks + CAS DELETE
    for (const role of manifest.createdRoles) {
      const current = await pool.query(
        `SELECT id, name, display_name, description, is_system, is_active, workspace_id,
                metadata, created_at, updated_at
           FROM rbac_roles WHERE id = $1 FOR UPDATE`,
        [role.id],
      );
      if (!current.rows[0]) continue;
      if (current.rows[0].workspace_id != null) {
        throw new Error(
          `CAS restore conflict: created role ${role.id} workspace_id drifted — refuse delete`,
        );
      }
      // Optional concurrency barrier after lock (tests inject foreign insert attempts here)
      if (hooks?.afterRoleLocked) {
        await hooks.afterRoleLocked(role.id);
      }

      const userLinks = await pool.query(
        `SELECT id, user_id FROM rbac_user_roles WHERE role_id = $1`,
        [role.id],
      );
      if (userLinks.rows.length > 0) {
        throw new Error(
          `CAS restore conflict: created role ${role.id} has concurrent/foreign user_role links — refuse delete`,
        );
      }

      const rolePerms = await pool.query(
        `SELECT role_id, permission_id FROM rbac_role_permissions WHERE role_id = $1`,
        [role.id],
      );
      for (const rp of rolePerms.rows) {
        const key = `${rp.role_id}|${rp.permission_id}`;
        if (!suiteLinkKeys.has(key)) {
          throw new Error(
            `CAS restore conflict: created role ${role.id} has foreign role_permission ${key} — refuse delete`,
          );
        }
        await pool.query(
          `DELETE FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`,
          [rp.role_id, rp.permission_id],
        );
      }

      // Atomic CAS DELETE: full after-state predicate only (no separate JS-only gate)
      const deleted = await pool.query(
        `DELETE FROM rbac_roles
          WHERE id = $1
            AND name = $2
            AND display_name = $3
            AND description IS NOT DISTINCT FROM $4
            AND is_system = $5
            AND is_active = $6
            AND workspace_id IS NULL
            AND COALESCE(metadata, '{}'::jsonb) = $7::jsonb
            AND created_at = $8::timestamptz
            AND updated_at = $9::timestamptz
          RETURNING id`,
        [
          role.id,
          role.name,
          role.displayName,
          role.description === '' ? null : role.description,
          role.isSystem,
          role.isActive,
          role.metadata,
          role.createdAt,
          role.updatedAt,
        ],
      );
      if (deleted.rowCount !== 1) {
        throw new Error(
          `CAS restore conflict: created role ${role.id} after-state drifted or concurrent change — refuse delete`,
        );
      }
    }

    // 5) Delete suite-created permissions — FOR UPDATE + full after-state CAS DELETE
    for (const perm of manifest.createdPermissions) {
      const current = await pool.query(
        `SELECT id, code, name, category, description, is_active, created_at, updated_at
           FROM rbac_permissions WHERE id = $1 FOR UPDATE`,
        [perm.id],
      );
      if (!current.rows[0]) continue;
      if (hooks?.afterPermissionLocked) {
        await hooks.afterPermissionLocked(perm.id);
      }

      const links = await pool.query(
        `SELECT role_id, permission_id FROM rbac_role_permissions WHERE permission_id = $1`,
        [perm.id],
      );
      for (const rp of links.rows) {
        const key = `${rp.role_id}|${rp.permission_id}`;
        if (!suiteLinkKeys.has(key)) {
          throw new Error(
            `CAS restore conflict: created permission ${perm.id} has foreign role_permission ${key} — refuse delete`,
          );
        }
      }
      const remaining = await pool.query(
        `SELECT 1 FROM rbac_role_permissions WHERE permission_id = $1 LIMIT 1`,
        [perm.id],
      );
      if (remaining.rows.length > 0) {
        throw new Error(
          `CAS restore conflict: created permission ${perm.id} still has role links — refuse delete`,
        );
      }
      const deleted = await pool.query(
        `DELETE FROM rbac_permissions
          WHERE id = $1
            AND code = $2
            AND name = $3
            AND category = $4
            AND description IS NOT DISTINCT FROM $5
            AND is_active = $6
            AND created_at = $7::timestamptz
            AND updated_at = $8::timestamptz
          RETURNING id`,
        [
          perm.id,
          perm.code,
          perm.name,
          perm.category,
          perm.description === '' ? null : perm.description,
          perm.isActive,
          perm.createdAt,
          perm.updatedAt,
        ],
      );
      if (deleted.rowCount !== 1) {
        throw new Error(
          `CAS restore conflict: created permission ${perm.id} after-state drifted or concurrent change — refuse delete`,
        );
      }
    }

    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
};

/** @deprecated use casRestoreGlobalDb with full manifest */
export const restoreGlobalDbDigest = async (
  _databaseUrl: string,
  _digest: GlobalDbDigest,
): Promise<void> => {
  throw new Error('restoreGlobalDbDigest removed — use casRestoreGlobalDb(manifest)');
};

/**
 * Seed principals + platform RBAC.
 * Tracks created IDs and mutated globals for true CAS restore.
 */
/**
 * Fail-closed durable restore handle.
 * - `restorable` is set synchronously after COMMIT with a pre-built journal (no await gap).
 * - Lifecycle restore prefers `restorable` immediately; never silently times out without restore.
 */
export type DurableRestoreHandle = {
  databaseUrl: string;
  /** True after COMMIT when journal+seed are published. */
  committed: boolean;
  /** Pre-built restore journal published before/at commit arm. */
  manifest: SuiteGlobalWriteManifest | null;
  seed: SuiteSeed | null;
  /** True when seed attempt finished (success or failure). */
  settled: boolean;
  whenSettled: Promise<void>;
  markSettled: () => void;
  /** Fail-closed: set when seed must not hang restore forever. */
  abortRestoreWait: () => void;
};

/** Create an empty durable restore handle — register on lifecycle BEFORE calling seed. */
export const createDurableRestoreHandle = (databaseUrl: string): DurableRestoreHandle => {
  let settled = false;
  let resolveSettled: () => void = () => undefined;
  const whenSettled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const handle: DurableRestoreHandle = {
    abortRestoreWait: () => {
      handle.markSettled();
    },
    committed: false,
    databaseUrl,
    manifest: null,
    markSettled: () => {
      if (settled) return;
      settled = true;
      handle.settled = true;
      resolveSettled();
    },
    seed: null,
    settled: false,
    whenSettled,
  };
  return handle;
};

export const seedEnterpriseAdminSuite = async (
  databaseUrl: string,
  /** Prefer pre-registered handle so signal handlers see restore as soon as COMMIT lands. */
  durableRestoreHandle?: DurableRestoreHandle,
): Promise<{
  durableRestore: DurableRestoreHandle;
  globalBefore: GlobalDbDigest;
  manifest: SuiteGlobalWriteManifest;
  seed: SuiteSeed;
}> => {
  // Enter durable handle BEFORE first async work (fail-closed settlement always).
  const durableRestore = durableRestoreHandle ?? createDurableRestoreHandle(databaseUrl);
  durableRestore.databaseUrl = databaseUrl;

  try {
    return await seedEnterpriseAdminSuiteInner(databaseUrl, durableRestore);
  } finally {
    durableRestore.settled = true;
    durableRestore.markSettled();
  }
};

const seedEnterpriseAdminSuiteInner = async (
  databaseUrl: string,
  durableRestore: DurableRestoreHandle,
): Promise<{
  durableRestore: DurableRestoreHandle;
  globalBefore: GlobalDbDigest;
  manifest: SuiteGlobalWriteManifest;
  seed: SuiteSeed;
}> => {
  // Fail-closed early rejection after handle entry (tests); never leaves committed pollution.
  if (process.env.E2E_CAS_FORCE_EARLY_FAIL === '1') {
    throw new Error('forced early seed failure before transaction work');
  }

  const globalBefore = await snapshotGlobalDbDigest(databaseUrl);
  const beforeLinkKeys = new Set(
    globalBefore.platformRolePermissions.map((l) => `${l.roleId}|${l.permissionId}`),
  );
  const beforePoliciesByResource = new Map(
    globalBefore.managedPolicies.map((p) => [p.resource, p] as const),
  );

  const namespace = createSuiteNamespace();
  const password = `E2e!${nano(8)}A1`;
  const ordinary = makePrincipal(namespace, 'ordinary', password);
  const owner = makePrincipal(namespace, 'owner', password);
  const superAdmin = makePrincipal(namespace, 'super_admin', password);
  const auditor = makePrincipal(namespace, 'auditor', password);
  const workspaceId = `ws_${namespace}`.slice(0, 32);
  const workspaceSlug = `ws-${namespace}`.slice(0, 80);
  const passwordHash = await bcrypt.hash(password, 10);
  const pool = new Pool({ connectionString: databaseUrl });
  const now = new Date().toISOString();
  const onboarding = JSON.stringify({ finishedAt: now, version: 1 });

  const createdPermissionIds: string[] = [];
  const createdRoleIds: string[] = [];
  const createdPolicyIds: string[] = [];
  const createdRolePermissionKeys: Array<{ permissionId: string; roleId: string }> = [];
  const mutatedPolicies: SuiteGlobalWriteManifest['mutatedPolicies'] = [];

  try {
    await pool.query('BEGIN');

    if (process.env.E2E_CAS_FORCE_TXN_ROLLBACK === '1') {
      throw new Error('forced mid-transaction rollback');
    }

    for (const code of PLATFORM_PERMISSIONS) {
      const category = code.split(':')[0] || 'platform';
      const candidateId = `perm_${nano(8)}`;
      const inserted = await pool.query(
        `INSERT INTO rbac_permissions (id, code, name, category, description, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $6)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [candidateId, code, code, category, code, now],
      );
      if (inserted.rows[0]?.id) {
        createdPermissionIds.push(String(inserted.rows[0].id));
      }
    }

    const roleIds = new Map<string, string>();
    for (const roleName of PLATFORM_ROLES) {
      const candidateId = `role_${roleName}_${nano(4)}`;
      const inserted = await pool.query(
        `INSERT INTO rbac_roles (id, name, display_name, description, is_system, is_active, metadata, workspace_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, true, '{}'::jsonb, NULL, $5, $5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [candidateId, roleName, roleName, `platform ${roleName}`, now],
      );
      if (inserted.rows[0]?.id) {
        createdRoleIds.push(String(inserted.rows[0].id));
      }
      const found = await pool.query(
        `SELECT id FROM rbac_roles WHERE name = $1 AND workspace_id IS NULL LIMIT 1`,
        [roleName],
      );
      if (!found.rows[0]?.id) throw new Error(`failed to seed platform role ${roleName}`);
      const id = found.rows[0].id as string;
      roleIds.set(roleName, id);

      for (const code of ROLE_PERMISSION_MAP[roleName]) {
        const perm = await pool.query(`SELECT id FROM rbac_permissions WHERE code = $1 LIMIT 1`, [
          code,
        ]);
        const permissionId = perm.rows[0]?.id as string | undefined;
        if (!permissionId) continue;
        const link = await pool.query(
          `INSERT INTO rbac_role_permissions (role_id, permission_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING role_id, permission_id`,
          [id, permissionId],
        );
        if (link.rows[0]) {
          const key = `${id}|${permissionId}`;
          if (!beforeLinkKeys.has(key)) {
            createdRolePermissionKeys.push({ permissionId, roleId: id });
          }
        }
      }
    }

    const insertUser = async (user: SuitePrincipal) => {
      await pool.query(
        `INSERT INTO users (id, email, normalized_email, username, full_name, email_verified, onboarding, created_at, updated_at, last_active_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $7, $7)
         ON CONFLICT (id) DO UPDATE SET onboarding = $6, updated_at = $7`,
        [
          user.id,
          user.email,
          user.email.toLowerCase(),
          user.username,
          user.fullName,
          onboarding,
          now,
        ],
      );
      await pool.query(
        `INSERT INTO accounts (id, user_id, account_id, provider_id, password, created_at, updated_at)
         VALUES ($1, $2, $3, 'credential', $4, $5, $5)
         ON CONFLICT (id) DO UPDATE SET password = $4, updated_at = $5`,
        [user.accountId, user.id, user.email, passwordHash, now],
      );
    };

    for (const user of [ordinary, owner, superAdmin, auditor]) {
      await insertUser(user);
    }

    const assignGlobal = async (userId: string, roleName: string) => {
      const roleId = roleIds.get(roleName);
      if (!roleId) throw new Error(`missing platform role ${roleName}`);
      await pool.query(
        `INSERT INTO rbac_user_roles (id, user_id, role_id, workspace_id, created_at)
         VALUES ($1::uuid, $2, $3, NULL, $4)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), userId, roleId, now],
      );
    };

    await assignGlobal(superAdmin.id, 'super_admin');
    await assignGlobal(auditor.id, 'auditor');

    await pool.query(
      `INSERT INTO workspaces (id, slug, name, description, primary_owner_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, workspaceSlug, `E2E WS ${namespace}`, 'enterprise-admin e2e', owner.id, now],
    );

    const ownerRoleCandidate = `role_ws_owner_${nano(4)}`;
    await pool.query(
      `INSERT INTO rbac_roles (id, name, display_name, description, is_system, is_active, workspace_id, created_at, updated_at)
       VALUES ($1, 'workspace_owner', 'Workspace Owner', 'workspace owner', true, true, $2, $3, $3)
       ON CONFLICT DO NOTHING`,
      [ownerRoleCandidate, workspaceId, now],
    );
    const ownerRole = await pool.query(
      `SELECT id FROM rbac_roles WHERE name = 'workspace_owner' AND workspace_id = $1 LIMIT 1`,
      [workspaceId],
    );
    const resolvedOwnerRoleId = ownerRole.rows[0]?.id as string | undefined;
    if (!resolvedOwnerRoleId) throw new Error('workspace_owner role seed failed');
    await pool.query(
      `INSERT INTO rbac_user_roles (id, user_id, role_id, workspace_id, created_at)
       VALUES ($1::uuid, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), owner.id, resolvedOwnerRoleId, workspaceId, now],
    );

    // Managed policies: INSERT when missing. Mutate skills only when needed, with before/after CAS.
    for (const resource of MANAGED_RESOURCES) {
      const managed = resource === 'skills';
      const item = { enforcementMode: managed ? 'enforced' : 'observe', managed };
      const config = JSON.stringify({ draft: item, published: item });
      const policyId = `pmrp_${resource}_${nano(4)}`;
      const inserted = await pool.query(
        `INSERT INTO platform_managed_resource_policies
           (id, resource, status, revision, enforcement, config, created_at, updated_at)
         VALUES ($1, $2, 'published', 1, $3, $4::jsonb, $5, $5)
         ON CONFLICT (resource) DO NOTHING
         RETURNING id`,
        [policyId, resource, managed ? 'enforced' : 'observe', config, now],
      );
      if (inserted.rows[0]?.id) {
        createdPolicyIds.push(String(inserted.rows[0].id));
      }
    }

    // Skills must be managed+enforced for fail-closed tests.
    const skillsBefore = beforePoliciesByResource.get('skills');
    const skillsCurrent = await pool.query(
      `SELECT id, resource, status, revision, enforcement, config::text AS config
         FROM platform_managed_resource_policies WHERE resource = 'skills' LIMIT 1`,
    );
    if (skillsCurrent.rows[0]) {
      const cur: ManagedPolicyRow = {
        config: String(skillsCurrent.rows[0].config ?? ''),
        enforcement: String(skillsCurrent.rows[0].enforcement ?? ''),
        id: String(skillsCurrent.rows[0].id),
        resource: 'skills',
        revision: Number(skillsCurrent.rows[0].revision),
        status: String(skillsCurrent.rows[0].status),
      };
      const managedTrue =
        cur.config.includes('"managed":true') || cur.config.includes('"managed": true');
      const needsMutation = cur.enforcement !== 'enforced' || !managedTrue;
      if (needsMutation && skillsBefore && !createdPolicyIds.includes(cur.id)) {
        const desiredConfig = JSON.stringify({
          draft: { enforcementMode: 'enforced', managed: true },
          published: { enforcementMode: 'enforced', managed: true },
        });
        const updated = await pool.query(
          `UPDATE platform_managed_resource_policies
              SET status = 'published',
                  revision = GREATEST(revision, 1),
                  enforcement = 'enforced',
                  config = $2::jsonb,
                  updated_at = $1
            WHERE id = $3 AND resource = 'skills'
            RETURNING id, resource, status, revision, enforcement, config::text AS config`,
          [now, desiredConfig, cur.id],
        );
        if (updated.rows[0]) {
          const after: ManagedPolicyRow = {
            config: String(updated.rows[0].config ?? ''),
            enforcement: String(updated.rows[0].enforcement ?? ''),
            id: String(updated.rows[0].id),
            resource: 'skills',
            revision: Number(updated.rows[0].revision),
            status: String(updated.rows[0].status),
          };
          mutatedPolicies.push({ after, before: skillsBefore });
        }
      }
    }

    // Pre-COMMIT journal: full after-state for created rows (same txn, visible uncommitted).
    const createdPermIdSet = new Set(createdPermissionIds);
    const createdRoleIdSet = new Set(createdRoleIds);
    const createdPolicyIdSet = new Set(createdPolicyIds);

    let createdPermissions: PlatformPermissionRow[] = [];
    let createdRoles: PlatformRoleRow[] = [];
    if (createdPermIdSet.size > 0) {
      const permRows = await pool.query(
        `SELECT id, code, name, category, description, is_active, created_at, updated_at
           FROM rbac_permissions WHERE id = ANY($1::text[])`,
        [[...createdPermIdSet]],
      );
      createdPermissions = permRows.rows.map((r) => mapPermissionRow(r as Record<string, unknown>));
    }
    if (createdRoleIdSet.size > 0) {
      const roleRows = await pool.query(
        `SELECT id, name, display_name, description, is_system, is_active, workspace_id,
                metadata, created_at, updated_at
           FROM rbac_roles WHERE id = ANY($1::text[]) AND workspace_id IS NULL`,
        [[...createdRoleIdSet]],
      );
      createdRoles = roleRows.rows.map((r) => mapRoleRow(r as Record<string, unknown>));
    }

    const policyRows = await pool.query(
      `SELECT id, resource, status, revision, enforcement, config::text AS config
         FROM platform_managed_resource_policies
        WHERE id = ANY($1::text[]) OR resource = ANY($2::text[])`,
      [[...createdPolicyIdSet], MANAGED_RESOURCES],
    );
    const createdPolicies: ManagedPolicyRow[] = policyRows.rows
      .filter((r) => createdPolicyIdSet.has(String(r.id)))
      .map((row) => ({
        config: String(row.config ?? ''),
        enforcement: String(row.enforcement ?? ''),
        id: String(row.id),
        resource: String(row.resource),
        revision: Number(row.revision),
        status: String(row.status),
      }));

    // Links created this suite (visible in-txn)
    const linkRows = await pool.query(
      `SELECT r.id AS role_id, r.name AS role_name, p.id AS permission_id, p.code AS permission_code
         FROM rbac_role_permissions rp
         JOIN rbac_roles r ON r.id = rp.role_id
         JOIN rbac_permissions p ON p.id = rp.permission_id
        WHERE r.workspace_id IS NULL AND r.name = ANY($1::text[])`,
      [PLATFORM_ROLES],
    );
    const createdLinks = linkRows.rows
      .filter((l) => !beforeLinkKeys.has(`${l.role_id}|${l.permission_id}`))
      .map((l) => ({
        fingerprint: linkFingerprint({
          permissionId: String(l.permission_id),
          roleId: String(l.role_id),
        }),
        permissionCode: String(l.permission_code),
        permissionId: String(l.permission_id),
        roleId: String(l.role_id),
        roleName: String(l.role_name),
      }));

    // Also catch links on newly created roles only (already covered above)

    const suiteSeed: SuiteSeed = {
      auditor,
      namespace,
      ordinary,
      owner,
      superAdmin,
      workspaceId,
      workspaceSlug,
    };

    // Lightweight after digest for journal (roles/perms ids only for GlobalDbDigest equality)
    const afterLite: GlobalDbDigest = {
      managedPolicies: policyRows.rows.map((row) => ({
        config: String(row.config ?? ''),
        enforcement: String(row.enforcement ?? ''),
        id: String(row.id),
        resource: String(row.resource),
        revision: Number(row.revision),
        status: String(row.status),
      })),
      platformPermissions: [
        ...globalBefore.platformPermissions,
        ...createdPermissions.map((p) => ({ code: p.code, id: p.id })),
      ],
      platformRolePermissions: [
        ...globalBefore.platformRolePermissions,
        ...createdLinks.map((l) => ({
          permissionCode: l.permissionCode,
          permissionId: l.permissionId,
          roleId: l.roleId,
          roleName: l.roleName,
        })),
      ],
      platformRoles: [
        ...globalBefore.platformRoles,
        ...createdRoles.map((r) => ({ id: r.id, name: r.name })),
      ],
    };

    const journal: SuiteGlobalWriteManifest = {
      after: afterLite,
      before: globalBefore,
      createdPermissions,
      createdPolicies,
      createdRolePermissionKeys: createdLinks,
      createdRoles,
      mutatedPolicies,
    };

    // Publish journal on handle BEFORE COMMIT so signal after COMMIT has restorable state.
    durableRestore.manifest = journal;
    durableRestore.seed = suiteSeed;

    await pool.query('COMMIT');

    // Synchronous arm — no await between COMMIT resolve and committed=true.
    durableRestore.committed = true;
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    // If never committed, clear partial journal so restore is no-op
    if (!durableRestore.committed) {
      durableRestore.manifest = null;
      durableRestore.seed = null;
    }
    throw error;
  } finally {
    await pool.end();
  }

  if (!durableRestore.manifest || !durableRestore.seed) {
    throw new Error('seed completed without durable journal');
  }

  // Optional hang after arm (tests force deadlock / pre-ready signal while restorable).
  const barrierDir = process.env.E2E_CAS_POST_COMMIT_BARRIER_DIR;
  if (barrierDir) {
    const { writeFileSync, existsSync } = await import('node:fs');
    writeFileSync(`${barrierDir}/post-commit`, '1', 'utf8');
    const release = `${barrierDir}/release`;
    const deadline = Date.now() + 60_000;
    while (!existsSync(release) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Optional forced post-commit reporting failure (journal already restorable).
  if (process.env.E2E_CAS_FORCE_POST_COMMIT_FAIL === '1') {
    throw new Error('forced post-COMMIT reporting failure (journal remains restorable)');
  }

  // Best-effort post-commit full digest refresh (may fail without losing restore).
  try {
    const after = await snapshotGlobalDbDigest(databaseUrl);
    durableRestore.manifest = {
      ...durableRestore.manifest,
      after,
    };
  } catch {
    // journal remains valid
  }

  return {
    durableRestore,
    globalBefore,
    manifest: durableRestore.manifest,
    seed: durableRestore.seed,
  };
};

/** Exact cleanup of suite namespace data + CAS restore of globals. */
export const cleanupEnterpriseAdminSuite = async (
  databaseUrl: string,
  seed: SuiteSeed | undefined,
  manifest?: SuiteGlobalWriteManifest,
): Promise<void> => {
  if (!seed) return;
  const pool = new Pool({ connectionString: databaseUrl });
  const ids = [seed.ordinary.id, seed.owner.id, seed.superAdmin.id, seed.auditor.id];
  try {
    await pool.query('BEGIN');
    await pool.query(`DELETE FROM auth_sessions WHERE user_id = ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM rbac_user_roles WHERE user_id = ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM accounts WHERE user_id = ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM rbac_roles WHERE workspace_id = $1`, [seed.workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [seed.workspaceId]);
    // Suite outage probe skill if left behind
    await pool
      .query(`DELETE FROM platform_skills WHERE skill_key = 'e2e.skill.outage.probe'`)
      .catch(() => undefined);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }

  if (manifest) {
    await casRestoreGlobalDb(databaseUrl, manifest);
  }
};

/**
 * Register durable seed restore as a preCleanup hook on the single lifecycle owner.
 * Prefer this over separate signal handlers (no competing async exits).
 * Uses durableRestore so restore works even if signal fires right after commit.
 */
export const registerSeedRestoreOnLifecycle = (
  state: {
    preCleanupHooks: Array<() => Promise<void>>;
  },
  durableRestore: DurableRestoreHandle,
): void => {
  let restored = false;
  state.preCleanupHooks.push(async () => {
    const restoreOnce = async () => {
      if (restored) return;
      if (!durableRestore.committed || !durableRestore.seed || !durableRestore.manifest) {
        return;
      }
      restored = true;
      await cleanupEnterpriseAdminSuite(
        durableRestore.databaseUrl,
        durableRestore.seed,
        durableRestore.manifest,
      );
    };

    // Prefer immediate restore when already restorable (even if seed hangs post-commit).
    if (durableRestore.committed && durableRestore.manifest && durableRestore.seed) {
      await restoreOnce();
      return;
    }

    // Not yet committed: wait for settle with bounded fail-closed timeout (timer cancelled).
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        durableRestore.whenSettled,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, 30_000);
          // Do not keep the process alive solely for this timer.
          if (typeof timer === 'object' && 'unref' in timer) {
            (timer as { unref: () => void }).unref();
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (durableRestore.committed && durableRestore.manifest && durableRestore.seed) {
      await restoreOnce();
      return;
    }
    if (timedOut && !durableRestore.committed) {
      // No committed pollution — fail-closed no-op (or throw if desired).
      return;
    }
    if (timedOut && durableRestore.committed) {
      // Should have restored above; force one more attempt.
      await restoreOnce();
    }
  });
};

/**
 * @deprecated Prefer registerSeedRestoreOnLifecycle on the single suite owner.
 * Kept for external mode without docker lifecycle.
 */
export const installManifestRestoreOnSignals = (
  databaseUrl: string,
  seed: SuiteSeed,
  manifest: SuiteGlobalWriteManifest,
): (() => void) => {
  let running = false;
  const handler = () => {
    if (running) return;
    running = true;
    void cleanupEnterpriseAdminSuite(databaseUrl, seed, manifest)
      .catch((error) => console.error('[seed-cas] interrupt restore failed', error))
      .finally(() => {
        process.exit(143);
      });
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
};

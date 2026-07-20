import { randomBytes, randomUUID } from 'node:crypto';

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

/**
 * Seed randomized principals + platform RBAC + one workspace_owner via official tables.
 * SQL against the migrated schema only — no production bootstrap HTTP backdoor.
 */
export const seedEnterpriseAdminSuite = async (databaseUrl: string): Promise<SuiteSeed> => {
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

  try {
    await pool.query('BEGIN');

    for (const code of PLATFORM_PERMISSIONS) {
      const category = code.split(':')[0] || 'platform';
      await pool.query(
        `INSERT INTO rbac_permissions (id, code, name, category, description, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $6)
         ON CONFLICT (code) DO NOTHING`,
        [`perm_${nano(8)}`, code, code, category, code, now],
      );
    }

    const roleIds = new Map<string, string>();
    for (const roleName of PLATFORM_ROLES) {
      const candidateId = `role_${roleName}_${nano(4)}`;
      await pool.query(
        `INSERT INTO rbac_roles (id, name, display_name, description, is_system, is_active, workspace_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, true, NULL, $5, $5)
         ON CONFLICT DO NOTHING`,
        [candidateId, roleName, roleName, `platform ${roleName}`, now],
      );
      const found = await pool.query(
        `SELECT id FROM rbac_roles WHERE name = $1 AND workspace_id IS NULL LIMIT 1`,
        [roleName],
      );
      if (!found.rows[0]?.id) throw new Error(`failed to seed platform role ${roleName}`);
      const id = found.rows[0].id as string;
      roleIds.set(roleName, id);

      await pool.query(`DELETE FROM rbac_role_permissions WHERE role_id = $1`, [id]);
      for (const code of ROLE_PERMISSION_MAP[roleName]) {
        const perm = await pool.query(`SELECT id FROM rbac_permissions WHERE code = $1 LIMIT 1`, [
          code,
        ]);
        const permissionId = perm.rows[0]?.id as string | undefined;
        if (!permissionId) continue;
        await pool.query(
          `INSERT INTO rbac_role_permissions (role_id, permission_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [id, permissionId],
        );
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

    for (const resource of ['agents', 'aiModels', 'aiProviders', 'connectors', 'skills']) {
      const managed = resource === 'skills';
      const item = { enforcementMode: managed ? 'enforced' : 'observe', managed };
      const config = JSON.stringify({ draft: item, published: item });
      await pool.query(
        `INSERT INTO platform_managed_resource_policies
           (id, resource, status, revision, enforcement, config, created_at, updated_at)
         VALUES ($1, $2, 'published', 1, $3, $4::jsonb, $5, $5)
         ON CONFLICT (resource) DO UPDATE SET
           status = 'published',
           revision = 1,
           enforcement = EXCLUDED.enforcement,
           config = EXCLUDED.config,
           updated_at = EXCLUDED.updated_at`,
        [`pmrp_${resource}_${nano(4)}`, resource, managed ? 'enforced' : 'observe', config, now],
      );
    }

    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }

  return {
    auditor,
    namespace,
    ordinary,
    owner,
    superAdmin,
    workspaceId,
    workspaceSlug,
  };
};

/** Exact cleanup of suite namespace data (users, roles, workspace, sessions). */
export const cleanupEnterpriseAdminSuite = async (
  databaseUrl: string,
  seed: SuiteSeed | undefined,
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
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
};

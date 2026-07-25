/**
 * True CAS restore of suite-written global RBAC / managed-policy rows.
 */
import { Pool } from 'pg';

import {
  policyFingerprint,
  rolePermissionLinkFingerprint,
  tsIso,
  userRoleLinkFingerprint,
} from './fingerprints';
import type { CasRestoreHooks, ManagedPolicyRow, SuiteGlobalWriteManifest } from './types';

export const casRestoreGlobalDb = async (
  databaseUrl: string,
  manifest: SuiteGlobalWriteManifest,
  hooks?: CasRestoreHooks,
): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl });
  // Dedicated client so application_name + transaction share one backend for wait observation.
  const client = await pool.connect();
  const query = (text: string, params?: unknown[]) => client.query(text, params);
  const suiteLinkKeys = new Set(
    manifest.createdRolePermissionKeys.map((l) => `${l.roleId}|${l.permissionId}`),
  );
  try {
    if (hooks?.applicationName) {
      // SET does not accept bind params; set_config does.
      await query(`SELECT set_config('application_name', $1, false)`, [hooks.applicationName]);
    }
    await query('BEGIN');

    // 1) CAS-restore mutated existing policies
    for (const { before, after } of manifest.mutatedPolicies) {
      const current = await query(
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
      const updated = await query(
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
      const current = await query(
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
      const deleted = await query(
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

    // 3) Delete suite-created role_permission links only — full after-state CAS incl. created_at
    for (const link of manifest.createdRolePermissionKeys) {
      const current = await query(
        `SELECT role_id, permission_id, created_at FROM rbac_role_permissions
          WHERE role_id = $1 AND permission_id = $2 LIMIT 1`,
        [link.roleId, link.permissionId],
      );
      if (!current.rows[0]) continue;
      const curCreatedAt = tsIso(current.rows[0].created_at);
      const expectedFp = rolePermissionLinkFingerprint({
        createdAt: link.createdAt,
        permissionId: link.permissionId,
        roleId: link.roleId,
      });
      if (link.fingerprint !== expectedFp) {
        throw new Error(
          `CAS restore conflict: created role_permission ${link.roleId}|${link.permissionId} fingerprint mismatch`,
        );
      }
      if (curCreatedAt !== link.createdAt) {
        throw new Error(
          `CAS restore conflict: role_permission ${link.roleId}|${link.permissionId} created_at drifted (foreign reinsert) — refuse delete`,
        );
      }
      const deleted = await query(
        `DELETE FROM rbac_role_permissions
          WHERE role_id = $1 AND permission_id = $2 AND created_at = $3::timestamptz
          RETURNING role_id`,
        [link.roleId, link.permissionId, link.createdAt],
      );
      if (deleted.rowCount !== 1) {
        throw new Error(
          `CAS restore conflict: role_permission ${link.roleId}|${link.permissionId} after-state drifted during delete`,
        );
      }
    }

    // 3b) Delete suite-created user_role links — full after-state CAS (every stored column)
    for (const link of manifest.createdUserRoles ?? []) {
      const current = await query(
        `SELECT id, user_id, role_id, workspace_id, created_at, expires_at
           FROM rbac_user_roles WHERE id = $1::uuid LIMIT 1`,
        [link.id],
      );
      if (!current.rows[0]) continue;
      const cur = current.rows[0];
      const curBase = {
        createdAt: tsIso(cur.created_at),
        expiresAt: cur.expires_at == null ? null : tsIso(cur.expires_at),
        id: String(cur.id),
        roleId: String(cur.role_id),
        userId: String(cur.user_id),
        workspaceId: cur.workspace_id == null ? null : String(cur.workspace_id),
      };
      if (userRoleLinkFingerprint(curBase) !== link.fingerprint) {
        throw new Error(
          `CAS restore conflict: user_role ${link.id} after-state drifted (fingerprint) — refuse delete`,
        );
      }
      const deleted = await query(
        `DELETE FROM rbac_user_roles
          WHERE id = $1::uuid
            AND user_id = $2
            AND role_id = $3
            AND workspace_id IS NOT DISTINCT FROM $4
            AND created_at = $5::timestamptz
            AND expires_at IS NOT DISTINCT FROM $6::timestamptz
          RETURNING id`,
        [link.id, link.userId, link.roleId, link.workspaceId, link.createdAt, link.expiresAt],
      );
      if (deleted.rowCount !== 1) {
        throw new Error(
          `CAS restore conflict: user_role ${link.id} concurrent change during delete`,
        );
      }
    }

    // 4) Delete suite-created platform roles — FOR UPDATE holds parent through checks + CAS DELETE
    for (const role of manifest.createdRoles) {
      const current = await query(
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

      const userLinks = await query(`SELECT id, user_id FROM rbac_user_roles WHERE role_id = $1`, [
        role.id,
      ]);
      if (userLinks.rows.length > 0) {
        throw new Error(
          `CAS restore conflict: created role ${role.id} has concurrent/foreign user_role links — refuse delete`,
        );
      }

      const rolePerms = await query(
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
        await query(`DELETE FROM rbac_role_permissions WHERE role_id = $1 AND permission_id = $2`, [
          rp.role_id,
          rp.permission_id,
        ]);
      }

      // Atomic CAS DELETE: full after-state predicate only (no separate JS-only gate)
      const deleted = await query(
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
      const current = await query(
        `SELECT id, code, name, category, description, is_active, created_at, updated_at
           FROM rbac_permissions WHERE id = $1 FOR UPDATE`,
        [perm.id],
      );
      if (!current.rows[0]) continue;
      if (hooks?.afterPermissionLocked) {
        await hooks.afterPermissionLocked(perm.id);
      }

      const links = await query(
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
      const remaining = await query(
        `SELECT 1 FROM rbac_role_permissions WHERE permission_id = $1 LIMIT 1`,
        [perm.id],
      );
      if (remaining.rows.length > 0) {
        throw new Error(
          `CAS restore conflict: created permission ${perm.id} still has role links — refuse delete`,
        );
      }
      const deleted = await query(
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

    await query('COMMIT');
  } catch (error) {
    await query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

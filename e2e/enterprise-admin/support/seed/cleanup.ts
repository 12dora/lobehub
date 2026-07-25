/**
 * Exact cleanup of suite namespace data + CAS restore of globals.
 */
import { Pool, type PoolClient } from 'pg';

import { OUTAGE_SKILL_ID, OUTAGE_SKILL_KEY } from '../skillOutage';
import { casRestoreGlobalDb } from './casRestore';
import type { SuiteGlobalWriteManifest, SuiteSeed } from './types';

/** Exact cleanup of suite namespace data + CAS restore of globals. */
export const cleanupEnterpriseAdminSuite = async (
  databaseUrl: string,
  seed: SuiteSeed | undefined,
  manifest?: SuiteGlobalWriteManifest,
): Promise<void> => {
  if (!seed) return;
  // CAS-delete suite-owned links/roles/permissions first (full after-state only).
  if (manifest) {
    await casRestoreGlobalDb(databaseUrl, manifest);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const ids = [seed.ordinary.id, seed.owner.id, seed.superAdmin.id, seed.auditor.id];
  const ownedUserRoleIds = new Set((manifest?.createdUserRoles ?? []).map((l) => l.id));
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`DELETE FROM auth_sessions WHERE user_id = ANY($1::text[])`, [ids]);

    // Never broad-delete user_roles by suite user_id — only RETURNING-owned rows (via CAS above).
    // Any remaining row on a suite user means foreign dependency or incomplete CAS: fail closed.
    const residual = await client.query<{ id: string; user_id: string; role_id: string }>(
      `SELECT id, user_id, role_id FROM rbac_user_roles WHERE user_id = ANY($1::text[])`,
      [ids],
    );
    if (residual.rows.length > 0) {
      const foreign = residual.rows.filter((r) => !ownedUserRoleIds.has(String(r.id)));
      if (foreign.length > 0) {
        throw new Error(
          `CAS cleanup conflict: non-owned user_role ${foreign[0].id} still references suite user ${foreign[0].user_id} — refuse user delete`,
        );
      }
      throw new Error(
        `CAS cleanup conflict: suite-owned user_role ${residual.rows[0].id} still present after CAS restore — refuse user delete`,
      );
    }

    await client.query(`DELETE FROM accounts WHERE user_id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM rbac_roles WHERE workspace_id = $1`, [seed.workspaceId]);
    await client.query(`DELETE FROM workspaces WHERE id = $1`, [seed.workspaceId]);
    // Same exact ID/key predicate as restoreSkillCatalogOutage — never swallow DELETE failures.
    await client.query(`DELETE FROM platform_skills WHERE id = $1 OR skill_key = $2`, [
      OUTAGE_SKILL_ID,
      OUTAGE_SKILL_KEY,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
};

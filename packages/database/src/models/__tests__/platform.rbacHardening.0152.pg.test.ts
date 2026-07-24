// @vitest-environment node
/**
 * Real-Postgres privilege boundary for migration 0152_round2_rbac_hardening.
 *
 * Gate: TEST_SERVER_DB=1 and DATABASE_TEST_URL.
 *
 * The migration is a double-gated no-op scaffold: it REVOKEs DELETE from a dedicated
 * non-superuser app role ONLY when BOTH aihub.rbac_hardening_activate='on' AND that
 * role exists. It installs NO app-callable SECURITY DEFINER bypass. This test creates
 * a temp non-superuser role and asserts:
 *   - activated → direct DELETE on guarded tables is DENIED for that role (even with GUC),
 *     and no purge/bypass functions exist,
 *   - not activated → the privilege block is a complete no-op.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

const migrationSql = readFileSync(
  path.join(__dirname, '../../../migrations/0152_round2_rbac_hardening.sql'),
  'utf8',
);

/** Unique role name so parallel suites cannot collide. */
const ROLE = `aihub_app_0152_${process.pid}`;

const applySql = async (client: PoolClient, sqlText: string) => {
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed) await client.query(trimmed);
  }
};

const BYPASS_FN_NAMES = [
  'platform_purge_audit_logs',
  'platform_purge_agent_versions_for_agent',
  'platform_purge_agent_versions',
];

describe.skipIf(!enabled)('0152_round2_rbac_hardening (PostgreSQL privilege boundary)', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    pool = new Pool({ connectionString, max: 1 });
    client = await pool.connect();
  }, 60_000);

  afterAll(async () => {
    try {
      await client.query('RESET ROLE');
      await client.query(`REASSIGN OWNED BY ${ROLE} TO CURRENT_USER`);
      await client.query(`DROP OWNED BY ${ROLE}`);
      await client.query(`DROP ROLE IF EXISTS ${ROLE}`);
    } catch {
      /* ignore */
    }
    client.release();
    await pool.end();
  });

  it('activated + dedicated role → REVOKEs DELETE and installs NO bypass function', async () => {
    await client.query('RESET ROLE');
    await client.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await client.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '0152-test-only' NOSUPERUSER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    // Intentionally pre-grant DELETE so the migration's REVOKE is observable.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_audit_logs TO ${ROLE}`,
    );

    // Fixture row (superuser; GUC+DELETE in a SINGLE transaction so the append-only
    // trigger honours the transaction-local GUC — the bug the previous test had).
    await client.query('BEGIN');
    await client.query(`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await client.query(`DELETE FROM public.platform_audit_logs WHERE id LIKE '0152rbac-%'`);
    await client.query('COMMIT');
    await client.query(`
      INSERT INTO public.platform_audit_logs (id, action, target_type, result, created_at)
      VALUES ('0152rbac-direct', 't.direct', 'settings', 'success', '2020-01-01T00:00:00Z')
    `);

    // Activate BOTH gates and apply the REAL migration SQL (idempotent double apply).
    await client.query(`SELECT set_config('aihub.app_db_role', '${ROLE}', false)`);
    await client.query(`SELECT set_config('aihub.rbac_hardening_activate', 'on', false)`);
    await applySql(client, migrationSql);
    await applySql(client, migrationSql);

    // DELETE revoked from the dedicated role.
    const delPriv = await client.query<{ has: boolean }>(
      `SELECT has_table_privilege($1, 'platform_audit_logs', 'DELETE') AS has`,
      [ROLE],
    );
    expect(delPriv.rows[0]?.has).toBe(false);

    // No app-callable SECURITY DEFINER bypass exists.
    const fns = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
      [BYPASS_FN_NAMES],
    );
    expect(Number(fns.rows[0]?.n)).toBe(0);

    // As the least-privilege role, direct DELETE is denied even with the GUC set.
    await client.query(`SET ROLE ${ROLE}`);
    await client.query('BEGIN');
    await client.query(`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    let denied = false;
    try {
      await client.query(`DELETE FROM platform_audit_logs WHERE id = '0152rbac-direct'`);
    } catch (error) {
      denied = true;
      expect(String(error)).toMatch(/permission denied/i);
    }
    await client.query('ROLLBACK');
    await client.query('RESET ROLE');
    expect(denied).toBe(true);

    // Cleanup fixture (single transaction so the GUC is honoured).
    await client.query('BEGIN');
    await client.query(`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await client.query(`DELETE FROM public.platform_audit_logs WHERE id LIKE '0152rbac-%'`);
    await client.query('COMMIT');
  }, 60_000);

  it('activation marker unset → privilege block is a complete no-op (idempotent)', async () => {
    await client.query('RESET ROLE');
    await client.query(`SELECT set_config('aihub.rbac_hardening_activate', '', false)`);
    await client.query(`SELECT set_config('aihub.app_db_role', '${ROLE}', false)`);
    // Re-grant DELETE so we can observe it is NOT revoked.
    await client.query(`GRANT DELETE ON TABLE public.platform_audit_logs TO ${ROLE}`);

    await applySql(client, migrationSql);
    await applySql(client, migrationSql);

    const delPriv = await client.query<{ has: boolean }>(
      `SELECT has_table_privilege($1, 'platform_audit_logs', 'DELETE') AS has`,
      [ROLE],
    );
    // Not activated → REVOKE did not run → role keeps DELETE.
    expect(delPriv.rows[0]?.has).toBe(true);
  }, 60_000);
});

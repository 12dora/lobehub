/**
 * Cleanup contract: probe DELETE failures must reject cleanup and keep fixtures
 * (SCE-01 — no silent commit after swallowed cleanup errors).
 */
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupEnterpriseAdminSuite, seedEnterpriseAdminSuite } from './seed';
import { startCasPostgres } from './seed.casHarness';
import { OUTAGE_SKILL_ID, OUTAGE_SKILL_KEY } from './skillOutage';

describe('cleanupEnterpriseAdminSuite probe failure contract', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const stop = cleanups.pop()!;
      await stop().catch(() => undefined);
    }
  }, 60_000);

  it('rejects when outage probe DELETE fails and retains suite users + probe row', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);

    const { manifest, seed } = await seedEnterpriseAdminSuite(harness.databaseUrl);

    const pool = new Pool({ connectionString: harness.databaseUrl });
    try {
      await pool.query(
        `INSERT INTO platform_skills (id, skill_key) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET skill_key = EXCLUDED.skill_key`,
        [OUTAGE_SKILL_ID, OUTAGE_SKILL_KEY],
      );
      // Inject failure for the exact outage-probe predicate used by cleanup/restore.
      await pool.query(`
        CREATE OR REPLACE FUNCTION e2e_reject_outage_probe_delete() RETURNS trigger AS $$
        BEGIN
          IF OLD.id = '${OUTAGE_SKILL_ID}' OR OLD.skill_key = '${OUTAGE_SKILL_KEY}' THEN
            RAISE EXCEPTION 'injected probe delete failure';
          END IF;
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS e2e_reject_outage_probe_delete_trg ON platform_skills;
        CREATE TRIGGER e2e_reject_outage_probe_delete_trg
          BEFORE DELETE ON platform_skills
          FOR EACH ROW EXECUTE PROCEDURE e2e_reject_outage_probe_delete();
      `);
    } finally {
      await pool.end();
    }

    await expect(cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest)).rejects.toThrow(
      /injected probe delete failure/,
    );

    const verify = new Pool({ connectionString: harness.databaseUrl });
    try {
      const probe = await verify.query(
        `SELECT id, skill_key FROM platform_skills WHERE id = $1 OR skill_key = $2`,
        [OUTAGE_SKILL_ID, OUTAGE_SKILL_KEY],
      );
      expect(probe.rows).toHaveLength(1);

      // Transactional cleanup rolled back: suite principals still present (not reported clean).
      const users = await verify.query(`SELECT id FROM users WHERE id = ANY($1::text[])`, [
        [seed.ordinary.id, seed.owner.id, seed.superAdmin.id, seed.auditor.id],
      ]);
      expect(users.rows.length).toBe(4);

      const workspace = await verify.query(`SELECT id FROM workspaces WHERE id = $1`, [
        seed.workspaceId,
      ]);
      expect(workspace.rows).toHaveLength(1);

      // Drop trigger so harness stop/teardown can proceed.
      await verify.query(
        `DROP TRIGGER IF EXISTS e2e_reject_outage_probe_delete_trg ON platform_skills`,
      );
      await verify.query(`DROP FUNCTION IF EXISTS e2e_reject_outage_probe_delete()`);
    } finally {
      await verify.end();
    }

    // Successful cleanup after removing the injection.
    await cleanupEnterpriseAdminSuite(harness.databaseUrl, seed, manifest);
    const finalPool = new Pool({ connectionString: harness.databaseUrl });
    try {
      const users = await finalPool.query(`SELECT id FROM users WHERE id = ANY($1::text[])`, [
        [seed.ordinary.id, seed.owner.id, seed.superAdmin.id, seed.auditor.id],
      ]);
      expect(users.rows).toHaveLength(0);
      const probe = await finalPool.query(
        `SELECT id FROM platform_skills WHERE id = $1 OR skill_key = $2`,
        [OUTAGE_SKILL_ID, OUTAGE_SKILL_KEY],
      );
      expect(probe.rows).toHaveLength(0);
    } finally {
      await finalPool.end();
    }
  }, 120_000);
});

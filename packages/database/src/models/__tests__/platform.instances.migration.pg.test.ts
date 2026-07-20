// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';

const runPostgresMigration =
  process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const migrationPath = path.join(
  import.meta.dirname,
  '../../../migrations/0135_m14_platform_instance_revisions.sql',
);

describe.skipIf(!runPostgresMigration)('M14 PostgreSQL platform instance migration', () => {
  it('replays twice and enforces the opaque heartbeat and revision-state contract', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const migration = await readFile(migrationPath, 'utf8');
      for (let pass = 0; pass < 2; pass += 1) {
        for (const statement of migration.split('--> statement-breakpoint')) {
          if (statement.trim()) await client.query(statement);
        }
      }

      const instanceId = `pinst_${'a'.repeat(48)}`;
      await client.query(`INSERT INTO platform_instance_heartbeats (instance_id) VALUES ($1)`, [
        instanceId,
      ]);
      await client.query(
        `INSERT INTO platform_instance_revision_states
          (instance_id, domain, load_mode, source, health)
         VALUES ($1, 'settings', 'request_scoped', 'database', 'healthy')`,
        [instanceId],
      );

      const state = await client.query<{
        instance_id: string;
        loaded_at_is_db_authored: boolean;
        revision_is_null: boolean;
      }>(
        `SELECT state.instance_id,
                state.loaded_at <= clock_timestamp() AS loaded_at_is_db_authored,
                state.loaded_revision IS NULL AND state.loaded_revision_id IS NULL AS revision_is_null
           FROM platform_instance_revision_states state
          WHERE state.instance_id = $1 AND state.domain = 'settings'`,
        [instanceId],
      );
      expect(state.rows).toEqual([
        { instance_id: instanceId, loaded_at_is_db_authored: true, revision_is_null: true },
      ]);

      await client.query('SAVEPOINT invalid_revision_state');
      await expect(
        client.query(
          `INSERT INTO platform_instance_revision_states
            (instance_id, domain, load_mode, source, health, error_category)
           VALUES ($1, 'identity', 'process_cached', 'unavailable', 'healthy', NULL)`,
          [instanceId],
        ),
      ).rejects.toMatchObject({
        constraint: 'platform_instance_revision_states_outcome_check',
      });
      await client.query('ROLLBACK TO SAVEPOINT invalid_revision_state');

      await client.query('SAVEPOINT invalid_instance_id');
      await expect(
        client.query(`INSERT INTO platform_instance_heartbeats (instance_id) VALUES ('host-1')`),
      ).rejects.toMatchObject({ constraint: 'platform_instance_heartbeats_id_check' });
      await client.query('ROLLBACK TO SAVEPOINT invalid_instance_id');
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 30_000);
});

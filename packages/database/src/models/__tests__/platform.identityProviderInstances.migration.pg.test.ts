// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';

const runPostgresMigration = process.env.TEST_SERVER_DB === '1';
const migrationPath = path.join(
  __dirname,
  '../../../migrations/0130_m11_identity_provider_instances.sql',
);

describe.skipIf(!runPostgresMigration)('M11 PostgreSQL identity instance migration', () => {
  it('replays 0130 twice and enforces heartbeat and restart lifecycle constraints', async () => {
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
      const now = new Date();
      const instanceId = `oidci_${'a'.repeat(48)}`;
      await client.query(
        `INSERT INTO platform_identity_provider_instances
          (instance_id, startup_source, active_identity_revision, health, loaded_at, started_at,
           last_heartbeat, hostname_hash)
         VALUES ($1, 'database', $2, 'healthy', $3, $3, $3, $4)`,
        [instanceId, 'b'.repeat(64), now, 'c'.repeat(64)],
      );
      await client.query(
        `INSERT INTO platform_identity_provider_restart_requests
          (request_id, actor_id, target_instance_id, payload_hash, expected_identity_revision,
           intent_token_hash, expires_at, owner_fence)
         VALUES ('550e8400-e29b-41d4-a716-446655440130', 'admin', $1, $2, $3, $4,
                 $5, $6)`,
        [
          instanceId,
          'd'.repeat(64),
          'b'.repeat(64),
          'e'.repeat(64),
          new Date(now.getTime() + 60_000),
          'f'.repeat(64),
        ],
      );
      const result = await client.query(
        `SELECT i.health, r.status
           FROM platform_identity_provider_instances i
           JOIN platform_identity_provider_restart_requests r
             ON r.target_instance_id = i.instance_id`,
      );
      expect(result.rows).toEqual([{ health: 'healthy', status: 'prepared' }]);
      await expect(
        client.query(
          `UPDATE platform_identity_provider_restart_requests
              SET status = 'signaled', signaled_at = now()
            WHERE request_id = '550e8400-e29b-41d4-a716-446655440130'`,
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 20_000);
});

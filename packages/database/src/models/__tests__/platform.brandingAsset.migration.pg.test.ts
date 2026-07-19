// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';

const runPostgresMigration = process.env.TEST_SERVER_DB === '1';
const migrationPath = path.join(
  __dirname,
  '../../../migrations/0129_m12_platform_branding_assets.sql',
);

describe.skipIf(!runPostgresMigration)('M12 PostgreSQL branding asset migration', () => {
  it('replays twice and keeps platform assets after the attributed administrator is deleted', async () => {
    // Applies the complete migration chain to a clean PostgreSQL 17 database first.
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

      await client.query(`INSERT INTO users (id) VALUES ('m12-branding-admin')`);
      await client.query(`
        INSERT INTO platform_branding_assets
          (id, object_key, mime_type, size, sha256, width, height, kind, status,
           created_by, request_actor_id, operation, request_id, request_fingerprint,
           cleanup_after)
        VALUES
          ('pba_11111111-1111-4111-8111-111111111111',
           'platform/branding/11111111-1111-4111-8111-111111111111.png',
           'image/png', 68, repeat('a', 64), 1, 1, 'logo', 'ready',
           'm12-branding-admin', 'm12-branding-admin', 'branding.asset.upload',
           '22222222-2222-4222-8222-222222222222', repeat('b', 64), now())
      `);
      await client.query(`DELETE FROM users WHERE id = 'm12-branding-admin'`);

      const result = await client.query<{
        created_by: string | null;
        request_actor_id: string;
        status: string;
      }>(`
        SELECT created_by, request_actor_id, status
        FROM platform_branding_assets
        WHERE id = 'pba_11111111-1111-4111-8111-111111111111'
      `);
      expect(result.rows).toEqual([
        {
          created_by: null,
          request_actor_id: 'm12-branding-admin',
          status: 'ready',
        },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 30_000);
});

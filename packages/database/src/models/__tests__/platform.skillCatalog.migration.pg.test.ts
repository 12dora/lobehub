// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';

const runPostgresMigration = process.env.TEST_SERVER_DB === '1';
const migrationPath = path.join(
  __dirname,
  '../../../migrations/0122_m08_platform_skill_versions.sql',
);

const restoreM01ShellInsideTransaction = async (client: PoolClient) => {
  await client.query('TRUNCATE TABLE platform_skill_versions, platform_skills CASCADE');
  await client.query(
    'DROP TRIGGER IF EXISTS platform_skill_versions_immutable ON platform_skill_versions',
  );
  await client.query(
    'ALTER TABLE platform_skills DROP CONSTRAINT IF EXISTS platform_skills_current_version_same_skill_fk',
  );
  await client.query(
    'ALTER TABLE platform_skills DROP CONSTRAINT IF EXISTS platform_skills_published_version_required',
  );
  await client.query('DROP INDEX IF EXISTS platform_skill_versions_skill_id_id_unique');
  await client.query('DROP INDEX IF EXISTS platform_skill_versions_checksum_idx');
  await client.query('DROP INDEX IF EXISTS platform_skills_distribution_idx');
  await client.query('DROP INDEX IF EXISTS platform_skills_current_version_id_idx');
  await client.query('ALTER TABLE platform_skill_versions ALTER COLUMN checksum DROP NOT NULL');
  await client.query('ALTER TABLE platform_skill_versions RENAME COLUMN checksum TO zip_hash');
  await client.query('ALTER TABLE platform_skill_versions DROP COLUMN resources');
  await client.query('ALTER TABLE platform_skill_versions DROP COLUMN content');
  await client.query(
    "ALTER TABLE platform_skill_versions ALTER COLUMN manifest SET DEFAULT '{}'::jsonb",
  );
  await client.query(
    'ALTER TABLE platform_skills RENAME COLUMN current_version_id TO current_version',
  );
  await client.query('ALTER TABLE platform_skills DROP COLUMN allow_builtin_override');
  await client.query('ALTER TABLE platform_skills DROP COLUMN draft_sequence');
  await client.query("ALTER TABLE platform_skills ADD COLUMN manifest jsonb DEFAULT '{}'::jsonb");
};

describe.skipIf(!runPostgresMigration)('M08 PostgreSQL migration from the M01 shell', () => {
  it('performs the minimal empty-shell evolution and preserves the pointer-column rename', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await restoreM01ShellInsideTransaction(client);
      const sql = await readFile(migrationPath, 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.query(statement);
      }
      const columns = await client.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('platform_skills', 'platform_skill_versions')
      `);
      const names = new Set(columns.rows.map((row) => row.column_name));
      expect(names.has('current_version')).toBe(false);
      expect(names).toEqual(
        expect.objectContaining(
          new Set(['checksum', 'content', 'current_version_id', 'resources']),
        ),
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 15_000);

  it('rejects a non-empty legacy shell instead of fabricating frozen content/checksums', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await restoreM01ShellInsideTransaction(client);
      await client.query(
        "INSERT INTO platform_skills (id, skill_key, name, current_version) VALUES ('legacy', 'legacy', 'Legacy', '1.0.0')",
      );
      const sql = await readFile(migrationPath, 'utf8');
      const [emptyShellGuard] = sql.split('--> statement-breakpoint');
      await expect(client.query(emptyShellGuard)).rejects.toThrow(/shell tables to be empty/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 15_000);
});

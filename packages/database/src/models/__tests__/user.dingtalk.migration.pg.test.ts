// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';

const runPostgresMigration = process.env.TEST_SERVER_DB === '1';
const migrationPath = path.join(__dirname, '../../../migrations/0131_m11_user_dingtalk_claims.sql');

describe.skipIf(!runPostgresMigration)('M11 PostgreSQL user DingTalk claims migration', () => {
  it('replays 0131, permits duplicate claims and nulls, and creates no claim indexes', async () => {
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

      const columns = await client.query<{
        column_name: string;
        is_nullable: string;
      }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'users'
            AND column_name IN ('dingtalk_title', 'dingtalk_user_id')
          ORDER BY column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: 'dingtalk_title', is_nullable: 'YES' },
        { column_name: 'dingtalk_user_id', is_nullable: 'YES' },
      ]);

      const indexes = await client.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'users'
            AND indexdef ~ 'dingtalk_(title|user_id)'`,
      );
      expect(indexes.rows).toEqual([]);

      await client.query(
        `INSERT INTO users (id, dingtalk_title, dingtalk_user_id)
         VALUES ('m11-dingtalk-a', 'Engineer', 'ding-shared'),
                ('m11-dingtalk-b', 'Engineer', 'ding-shared'),
                ('m11-dingtalk-null', NULL, NULL)`,
      );
      const users = await client.query<{
        dingtalk_title: string | null;
        dingtalk_user_id: string | null;
        id: string;
      }>(
        `SELECT id, dingtalk_title, dingtalk_user_id
           FROM users
          WHERE id LIKE 'm11-dingtalk-%'
          ORDER BY id`,
      );
      expect(users.rows).toEqual([
        { dingtalk_title: 'Engineer', dingtalk_user_id: 'ding-shared', id: 'm11-dingtalk-a' },
        { dingtalk_title: 'Engineer', dingtalk_user_id: 'ding-shared', id: 'm11-dingtalk-b' },
        { dingtalk_title: null, dingtalk_user_id: null, id: 'm11-dingtalk-null' },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 20_000);
});

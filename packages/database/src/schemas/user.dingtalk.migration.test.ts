// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../migrations');
const migrationName = '0131_m11_user_dingtalk_claims';
const migrationSql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};
const snapshot = JSON.parse(
  readFileSync(path.join(migrations, 'meta/0131_snapshot.json'), 'utf8'),
) as {
  tables: Record<
    string,
    {
      columns: Record<string, { notNull: boolean; type: string }>;
      indexes: Record<string, unknown>;
    }
  >;
};

describe('M11 user DingTalk claims migration', () => {
  it('adds only nullable, non-indexed DingTalk claim columns with defensive DDL', () => {
    expect(migrationSql).toBe(
      'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dingtalk_title" text;--> statement-breakpoint\n' +
        'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dingtalk_user_id" text;\n',
    );
    expect(migrationSql).not.toMatch(/unique|create\s+(?:unique\s+)?index/i);
  });

  it('keeps the journal and generated snapshot aligned at 0131', () => {
    expect(journal.entries.find(({ idx }) => idx === 131)).toEqual({
      breakpoints: true,
      idx: 131,
      tag: migrationName,
      version: '7',
      when: expect.any(Number),
    });
    expect(readdirSync(path.join(migrations, 'meta'))).toContain('0131_snapshot.json');

    const users = snapshot.tables['public.users'];
    expect(users.columns.dingtalk_title).toMatchObject({ notNull: false, type: 'text' });
    expect(users.columns.dingtalk_user_id).toMatchObject({ notNull: false, type: 'text' });
    expect(JSON.stringify(users.indexes)).not.toMatch(/dingtalk_(?:title|user_id)/);
  });
});

// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const { join } = path;

/**
 * Guard: drizzle journal entries must stay 1:1 with meta snapshots.
 * Prevents the M02 hand-write drift that breaks the next `drizzle-kit generate`.
 */
describe('drizzle migration journal ↔ meta snapshots', () => {
  const migrationsDir = join(__dirname, '../../../migrations');
  const metaDir = join(migrationsDir, 'meta');

  it('journal entry count equals *_snapshot.json count', () => {
    const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8')) as {
      entries: { tag: string; idx: number }[];
    };
    const snapshots = readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json'));
    expect(journal.entries.length).toBe(snapshots.length);
  });

  it('each journal tag has a matching snapshot file', () => {
    const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8')) as {
      entries: { tag: string; idx: number }[];
    };
    for (const entry of journal.entries) {
      // tags like 0118_add_platform_easyauth_snapshots → 0118_snapshot.json
      const prefix = entry.tag.split('_')[0];
      const snapName = `${prefix}_snapshot.json`;
      expect(readdirSync(metaDir)).toContain(snapName);
    }
  });

  it('0118 SQL only creates platform_easyauth_grant_snapshots objects', () => {
    const sql = readFileSync(
      join(migrationsDir, '0118_add_platform_easyauth_snapshots.sql'),
      'utf8',
    );
    expect(sql).toMatch(/platform_easyauth_grant_snapshots/);
    expect(sql.toLowerCase()).not.toMatch(/drop table/);
    expect(sql.toLowerCase()).not.toMatch(/drop index "user_connectors/);
    expect(sql.toLowerCase()).not.toMatch(/alter table "(?!platform_easyauth)/);
  });
});

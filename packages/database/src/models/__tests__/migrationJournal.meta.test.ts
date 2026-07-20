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
  const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8')) as {
    entries: { tag: string; idx: number }[];
  };
  const snapshots = readdirSync(metaDir).filter((file) => file.endsWith('_snapshot.json'));

  it('maps every journal entry to exactly one snapshot without orphans', () => {
    const expectedSnapshots = journal.entries.map(
      ({ idx }) => `${String(idx).padStart(4, '0')}_snapshot.json`,
    );
    expect(snapshots.toSorted()).toEqual(expectedSnapshots);
  });

  it('keeps journal indexes contiguous and tags unique with matching prefixes', () => {
    expect(journal.entries.map(({ idx }) => idx)).toEqual(journal.entries.map((_, idx) => idx));
    expect(new Set(journal.entries.map(({ tag }) => tag)).size).toBe(journal.entries.length);
    journal.entries.forEach(({ idx, tag }) => {
      expect(tag.startsWith(`${String(idx).padStart(4, '0')}_`)).toBe(true);
    });
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

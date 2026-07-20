// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0134_m13_secret_rewrap_single_active';
const migrationSql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe('M13 secret rewrap single-active expand migration', () => {
  it('adds one idempotent partial unique index for every worker-active status', () => {
    expect(migrationSql.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g)).toHaveLength(1);
    expect(migrationSql).toContain('platform_jobs_secret_rewrap_single_active_unique');
    expect(migrationSql).toContain("type\" = 'platform.secret.rewrap.v1'");
    expect(migrationSql).toContain("status\" IN ('pending', 'reserved', 'running')");
    expect(migrationSql).not.toMatch(/\b(?:DROP|RENAME|DELETE|ALTER)\b/i);
  });

  it('keeps 0134 between the M13 failure index and M14 instance migration', () => {
    const journalPosition = journal.entries.findIndex(({ tag }) => tag === migrationName);
    expect(journalPosition).toBe(134);
    expect(journal.entries.slice(journalPosition - 1, journalPosition + 2)).toMatchObject([
      { idx: 133, tag: '0133_m13_secret_rewrap_failure_index' },
      { idx: 134, tag: migrationName },
      { idx: 135, tag: '0135_m14_platform_instance_revisions' },
    ]);
    expect(readdirSync(path.join(migrations, 'meta'))).toContain('0134_snapshot.json');
  });
});

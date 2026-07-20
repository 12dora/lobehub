// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0133_m13_secret_rewrap_failure_index';
const migrationSql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe('M13 secret rewrap failure-ledger expand migration', () => {
  it('adds only the idempotent partial expression index', () => {
    expect(migrationSql.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(1);
    expect(migrationSql).toContain('platform_jobs_secret_rewrap_failure_parent_domain_row_idx');
    expect(migrationSql).toContain("input\"->>'parentJobId'");
    expect(migrationSql).toContain("input\"->>'domain'");
    expect(migrationSql).toContain("input\"->>'rowId'");
    expect(migrationSql).toContain('platform.secret.rewrap.failure.v1');
    expect(migrationSql).toContain("status\" = 'failed'");
    expect(migrationSql).not.toMatch(/\b(?:DROP|RENAME|DELETE|ALTER)\b/i);
  });

  it('keeps generated journal and snapshot aligned at 0133', () => {
    expect(journal.entries).toHaveLength(134);
    expect(journal.entries.find(({ idx }) => idx === 133)).toMatchObject({
      idx: 133,
      tag: migrationName,
    });
    expect(readdirSync(path.join(migrations, 'meta'))).toContain('0133_snapshot.json');
  });
});

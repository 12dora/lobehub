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

  it('keeps generated journal and snapshot aligned at 0134', () => {
    expect(journal.entries).toHaveLength(135);
    expect(journal.entries.find(({ idx }) => idx === 134)).toMatchObject({
      idx: 134,
      tag: migrationName,
    });
    expect(readdirSync(path.join(migrations, 'meta'))).toContain('0134_snapshot.json');
  });
});

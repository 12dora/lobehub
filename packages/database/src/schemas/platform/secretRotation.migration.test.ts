// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0132_m13_platform_secret_rotation';
const migrationSequence = [
  migrationName,
  '0133_m13_secret_rewrap_failure_index',
  '0134_m13_secret_rewrap_single_active',
];
const migrationSql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe('M13 platform secret rotation expand migration', () => {
  it('adds only nullable AI key ids and the three inventory indexes idempotently', () => {
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "key_id" varchar(256)');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "secret_key_id" varchar(256)');
    expect(migrationSql.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(3);
    expect(migrationSql).toContain('platform_identity_provider_test_attempts_pkce_key_id_idx');
    expect(migrationSql).not.toMatch(/\b(?:DROP|RENAME|DELETE|DECRYPT)\b/i);
    expect(migrationSql).not.toMatch(/SET NOT NULL/i);
    expect(migrationSql).not.toMatch(/platform_jobs|failure/i);
  });

  it('keeps the M13 migration batch ordered with matching snapshots', () => {
    expect(journal.entries.slice(132, 135)).toMatchObject(
      migrationSequence.map((tag, offset) => ({ idx: 132 + offset, tag })),
    );
    expect(readdirSync(path.join(migrations, 'meta'))).toEqual(
      expect.arrayContaining(
        migrationSequence.map(
          (_, offset) => `${String(132 + offset).padStart(4, '0')}_snapshot.json`,
        ),
      ),
    );
  });
});

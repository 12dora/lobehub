// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0132_m13_platform_secret_rotation';
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

  it('keeps generated journal and snapshot aligned at 0132', () => {
    expect(journal.entries).toHaveLength(133);
    expect(journal.entries.find(({ idx }) => idx === 132)).toMatchObject({
      idx: 132,
      tag: migrationName,
    });
    expect(readdirSync(path.join(migrations, 'meta'))).toContain('0132_snapshot.json');
  });
});

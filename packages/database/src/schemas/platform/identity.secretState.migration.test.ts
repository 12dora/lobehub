// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0136_m11_identity_secret_state_null_guard';
const migrationSql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};
const snapshot = JSON.parse(
  readFileSync(path.join(migrations, 'meta/0136_snapshot.json'), 'utf8'),
) as {
  tables: Record<string, { checkConstraints?: Record<string, { name: string; value: string }> }>;
};

describe('M11 identity secret_state null-guard migration', () => {
  it('strengthens secret_state_check with explicit IS NOT NULL guards', () => {
    expect(migrationSql).toContain(
      'DROP CONSTRAINT IF EXISTS "platform_identity_providers_secret_state_check"',
    );
    expect(migrationSql).toContain(
      'ADD CONSTRAINT "platform_identity_providers_secret_state_check"',
    );
    expect(migrationSql).toContain('"secret_fingerprint" IS NOT NULL');
    expect(migrationSql).toContain('"secret_updated_at" IS NOT NULL');
    expect(migrationSql).toContain('"secret_fingerprint" ~ \'^[a-f0-9]{64}$\'');
    // Expand-only: no table drops / column drops.
    expect(migrationSql.toLowerCase()).not.toMatch(/drop table/);
    expect(migrationSql.toLowerCase()).not.toMatch(/drop column/);
  });

  it('keeps journal and snapshot aligned at 0136 with hardened check text', () => {
    expect(journal.entries.find(({ idx }) => idx === 136)).toEqual({
      breakpoints: true,
      idx: 136,
      tag: migrationName,
      version: '7',
      when: expect.any(Number),
    });
    expect(readdirSync(path.join(migrations, 'meta'))).toContain('0136_snapshot.json');
    const check =
      snapshot.tables['public.platform_identity_providers']?.checkConstraints?.[
        'platform_identity_providers_secret_state_check'
      ];
    expect(check?.value).toContain('secret_fingerprint" IS NOT NULL');
    expect(check?.value).toContain('secret_updated_at" IS NOT NULL');
  });
});

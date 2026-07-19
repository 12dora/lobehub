// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0127_m11_oidc_provider_security_foundation';
const migrationSql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe('M11 identity provider security foundation migration', () => {
  it('contains only identity-provider objects and uses defensive DDL', () => {
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "platform_identity_provider_secrets"',
    );
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "secret_ref"');
    expect(migrationSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS');
    expect(migrationSql).not.toMatch(/platform_(?:agents|connectors|skills|ai_providers)/);
  });

  it('retains unverifiable legacy material in fail-closed compatibility columns', () => {
    expect(migrationSql).not.toContain('DROP COLUMN IF EXISTS "encrypted_client_secret"');
    expect(migrationSql).not.toContain('DROP COLUMN IF EXISTS "discovery_url"');
    expect(migrationSql).toContain('ADD COLUMN "migration_required" boolean DEFAULT true');
    expect(migrationSql).toContain('WHERE "migration_required"');
    expect(migrationSql).toContain('"enabled" = false');
    expect(migrationSql).not.toMatch(/INSERT INTO "platform_(?:resource_revisions|audit_logs)"/);
  });

  it('does not narrow legacy text and normalizes structured policy before constraints', () => {
    expect(migrationSql).not.toMatch(/display_name" SET DATA TYPE varchar/);
    expect(migrationSql).not.toMatch(/button_label" SET DATA TYPE varchar/);
    expect(migrationSql).toContain(`USING '["openid","profile","email"]'::jsonb`);
    expect(migrationSql).toContain('"claim_mapping" =');
    expect(migrationSql).toContain('ADD CONSTRAINT "platform_identity_providers_pkce_check"');
  });

  it('keeps the generated journal and snapshot aligned at 0127', () => {
    expect(journal.entries.find(({ idx }) => idx === 127)).toEqual({
      breakpoints: true,
      idx: 127,
      tag: migrationName,
      version: '7',
      when: expect.any(Number),
    });
    expect(readdirSync(path.join(migrations, 'meta'))).toContain('0127_snapshot.json');
  });
});

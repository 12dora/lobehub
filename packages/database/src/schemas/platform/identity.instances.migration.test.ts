// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0130_m11_identity_provider_instances';
const migrationSql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe('M11 identity provider instance migration', () => {
  it('creates only secret-free runtime and restart-ledger tables with defensive DDL', () => {
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "platform_identity_provider_instances"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "platform_identity_provider_restart_requests"',
    );
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS');
    expect(migrationSql).toContain('CREATE INDEX IF NOT EXISTS');
    expect(migrationSql).not.toMatch(/issuer|client_secret|client_id|hostname"|pid|command/i);
  });

  it('keeps durable restart idempotency separate from instance heartbeat state', () => {
    const instanceTable = migrationSql.split('--> statement-breakpoint')[0]!;
    expect(instanceTable).toContain('"last_heartbeat"');
    expect(instanceTable).toContain('"active_identity_revision"');
    expect(instanceTable).not.toContain('"request_id"');
    expect(migrationSql).toContain('"request_id" uuid PRIMARY KEY');
    expect(migrationSql).toContain('"intent_token_hash" varchar(64)');
    expect(migrationSql).toContain('"owner_fence" varchar(64)');
  });

  it('keeps the generated journal and snapshot aligned at 0130', () => {
    expect(journal.entries.find(({ idx }) => idx === 130)).toEqual({
      breakpoints: true,
      idx: 130,
      tag: migrationName,
      version: '7',
      when: expect.any(Number),
    });
    expect(readdirSync(path.join(migrations, 'meta'))).toContain('0130_snapshot.json');
  });
});

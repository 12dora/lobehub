// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0123_m09_connector_catalog_expand';
const sql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const attemptMigrationName = '0124_m09_oauth_attempt_outcome';
const attemptSql = readFileSync(path.join(migrations, `${attemptMigrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe('M09 connector expand migration', () => {
  it('is expand-only and leaves every M01 compatibility column and index intact', () => {
    expect(sql).not.toMatch(/\b(?:DROP|RENAME)\b/i);
    expect(sql).not.toContain('platform_skills');
    expect(sql).not.toContain('platform_skill_versions');
    expect(sql).toContain(
      'ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "endpoint" text',
    );
    expect(sql).toContain(
      'ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "binding_status"',
    );
  });

  it('backfills only non-secret display fields before adding not-null constraints', () => {
    expect(sql).toContain('SET "display_name" = LEFT("name", 200)');
    expect(sql).toContain('SET "display_name" = LEFT("tool_key", 200)');
    expect(sql).not.toMatch(/SET\s+"?(?:oauth_config|shared_secret_ref|oauth_token_ref)"?/i);
    expect(sql).toContain('SET "endpoint" = NULLIF(BTRIM("mcp_server_url"), \'\')');
    expect(sql).toContain('AND "connection_type" = \'http\'');
    expect(sql).toContain('AND "encrypted_shared_credentials" IS NULL');
    expect(sql.indexOf('SET "display_name" = LEFT("name", 200)')).toBeLessThan(
      sql.indexOf('ALTER COLUMN "display_name" SET NOT NULL', sql.indexOf('platform_connectors')),
    );
  });

  it('uses phased validation, preserves orphan bindings, and documents online unique indexes', () => {
    expect(sql).toContain('CHECK ("display_name" IS NOT NULL) NOT VALID');
    expect(sql).toContain('VALIDATE CONSTRAINT "platform_connectors_display_name_nn"');
    expect(sql).toMatch(/platform_user_connector_bindings_user_id_users_id_fk[\s\S]+NOT VALID/);
    expect(sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(sql).toContain('M09_PREDEPLOY_INDEX_REQUIRED');
    expect(sql).not.toContain('platform_connectors_status_key_id_idx');
    expect(sql).not.toContain('platform_connector_tools_connector_sort_key_id_idx');
  });

  it('keeps journal and snapshots aligned after the follow-up attempt migration', () => {
    expect(journal.entries).toHaveLength(125);
    expect(journal.entries.at(-1)).toMatchObject({ idx: 124, tag: attemptMigrationName });
    expect(
      readdirSync(path.join(migrations, 'meta')).filter((file) => file.endsWith('_snapshot.json')),
    ).toHaveLength(125);
  });
});

describe('M09 OAuth attempt outcome migration', () => {
  it('adds only the attempt outcome fields with no stable-object drop or rename', () => {
    expect(attemptSql).not.toMatch(/\b(?:DROP|RENAME)\b/i);
    expect(attemptSql).toContain('ADD COLUMN IF NOT EXISTS "authorization_outcome"');
    expect(attemptSql).toContain('ADD COLUMN IF NOT EXISTS "finished_at"');
    expect(attemptSql).toContain('ADD CONSTRAINT "platform_connector_oauth_states_outcome_check"');
    expect(attemptSql).toContain('NOT VALID');
    expect(attemptSql).toContain(
      'VALIDATE CONSTRAINT "platform_connector_oauth_states_outcome_check"',
    );
    expect(attemptSql).not.toContain('platform_connectors');
    expect(attemptSql).not.toContain('platform_connector_secrets');
  });
});

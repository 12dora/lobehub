// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0125_m10_platform_agent_contract_expand';
const sql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe('M10 platform Agent expand migration', () => {
  it('is expand-only and preserves the M01 compatibility columns', () => {
    expect(sql).not.toMatch(/\b(?:DROP|RENAME)\b/i);
    expect(sql).not.toContain('ALTER COLUMN "config"');
    expect(sql).toContain(
      'ALTER TABLE "platform_agent_versions" ADD COLUMN IF NOT EXISTS "dependency_snapshot" jsonb',
    );
    expect(sql).toContain(
      'ALTER TABLE "platform_agent_versions" ADD COLUMN IF NOT EXISTS "checksum" varchar(64)',
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "platform_user_agent_materializations"');
  });

  it('isolates legacy shells without inventing exact dependency snapshots or checksums', () => {
    expect(sql).toContain('"migration_required" boolean DEFAULT true NOT NULL');
    expect(sql).toContain('SET "status" = \'draft\'');
    expect(sql).toContain('COALESCE("system_key" = \'default-inbox\', false)');
    expect(sql).not.toMatch(/SET\s+"(?:dependency_snapshot|checksum)"/i);
    expect(sql).not.toContain("repeat('0',64)");
  });

  it('orders composite unique indexes before exact foreign keys and phases old-table validation', () => {
    expect(sql.indexOf('platform_agent_versions_agent_id_id_unique')).toBeLessThan(
      sql.indexOf('platform_agent_assignments_pinned_version_same_agent_fk'),
    );
    expect(sql.indexOf('platform_agent_versions_agent_id_id_checksum_unique')).toBeLessThan(
      sql.indexOf('platform_user_agent_materializations_exact_version_fk'),
    );
    expect(sql).toMatch(/platform_agents_current_version_same_agent_fk[\s\S]+NOT VALID/);
    expect(sql).toContain('VALIDATE CONSTRAINT "platform_agents_current_version_same_agent_fk"');
    expect(sql).not.toContain('platform_agent_versions_checksum_idx');
  });

  it('installs serialized database guards for targets, exact publication, and immutability', () => {
    expect(sql).toContain('platform_agent_assignments_target_guard');
    expect(sql).toContain('rbac_roles_platform_agent_assignment_guard');
    expect(sql).toContain('users_platform_agent_assignment_guard');
    expect(sql).toContain('platform_user_agent_materializations_owner_guard');
    expect(sql).toContain('agents_materialization_owner_guard');
    expect(sql).toContain('platform_agent_versions_exact_insert_guard');
    expect(sql).toContain('platform_agents_exact_published_pointer_guard');
    expect(sql).toContain('platform_agent_versions_immutable');
    expect(sql).toMatch(/FROM "rbac_roles"[\s\S]+FOR KEY SHARE/);
    expect(sql).toMatch(/FROM "users" WHERE "id" = NEW\."target_id" FOR KEY SHARE/);
    expect(sql).toMatch(/FROM "agents"[\s\S]+FOR KEY SHARE/);
    expect(sql).toMatch(/FROM "platform_agent_versions"[\s\S]+FOR KEY SHARE/);
    expect(sql).toMatch(/FROM "rbac_roles" WHERE "id" = OLD\."id" FOR UPDATE/);
    expect(sql).toMatch(/FROM "agents" WHERE "id" = OLD\."id" FOR UPDATE/);
  });

  it('keeps journal and snapshots aligned at 0125', () => {
    expect(journal.entries).toHaveLength(126);
    expect(journal.entries.at(-1)).toMatchObject({ idx: 125, tag: migrationName });
    expect(
      readdirSync(path.join(migrations, 'meta')).filter((file) => file.endsWith('_snapshot.json')),
    ).toHaveLength(126);
  });
});

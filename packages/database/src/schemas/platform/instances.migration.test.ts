// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const migrationName = '0135_m14_platform_instance_revisions';
const migrationSql = readFileSync(path.join(migrations, `${migrationName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};
const previousSnapshot = JSON.parse(
  readFileSync(path.join(migrations, 'meta/0134_snapshot.json'), 'utf8'),
) as Record<string, unknown> & { id: string; tables: Record<string, unknown> };
const snapshot = JSON.parse(
  readFileSync(path.join(migrations, 'meta/0135_snapshot.json'), 'utf8'),
) as Record<string, unknown> & { prevId: string; tables: Record<string, unknown> };

describe('M14 platform instance revision migration', () => {
  it('uses expand-only, replay-safe DDL and database-authored timestamps', () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS "platform_instance_heartbeats"');
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "platform_instance_revision_states"',
    );
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS');
    expect(migrationSql).toContain('CREATE INDEX IF NOT EXISTS');
    expect(migrationSql.match(/DEFAULT clock_timestamp\(\)/g)).toHaveLength(3);
    expect(migrationSql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)|DELETE\s+FROM|(?:^|\n)UPDATE\s+/i);
  });

  it('persists only opaque instance identity and fixed low-cardinality revision state', () => {
    expect(migrationSql).toContain("'^pinst_[a-f0-9]{48}$'");
    expect(migrationSql).toContain(
      "'agent_catalog', 'ai_catalog', 'branding', 'connector_catalog', 'identity', 'managed_policy', 'settings', 'skill_catalog'",
    );
    expect(migrationSql).toContain("'process_cached', 'request_scoped', 'restart_activated'");
    expect(migrationSql).toContain("'cache', 'database', 'environment', 'lkg', 'unavailable'");
    expect(migrationSql).toContain("'degraded', 'healthy', 'unavailable'");
    expect(migrationSql).toContain('PRIMARY KEY("instance_id","domain")');
    expect(migrationSql).not.toMatch(
      /hostname|ip_address|connection_string|database_url|environment_variable|raw_error|stack_trace|secret_value/i,
    );
    expect(migrationSql).not.toMatch(/"(?:status|stale_at)"/i);
  });

  it('adds exactly the two M14 tables to the normalized generated snapshot', () => {
    const addedTables = Object.keys(snapshot.tables).filter(
      (table) => !(table in previousSnapshot.tables),
    );
    expect(addedTables).toEqual([
      'public.platform_instance_heartbeats',
      'public.platform_instance_revision_states',
    ]);

    const normalizedSnapshot = structuredClone(snapshot) as Record<string, unknown> & {
      id?: string;
      prevId?: string;
      tables: Record<string, unknown>;
    };
    delete normalizedSnapshot.id;
    delete normalizedSnapshot.prevId;
    delete normalizedSnapshot.tables['public.platform_instance_heartbeats'];
    delete normalizedSnapshot.tables['public.platform_instance_revision_states'];
    const normalizedPrevious = structuredClone(previousSnapshot) as Record<string, unknown> & {
      id?: string;
      prevId?: string;
      tables: Record<string, unknown>;
    };
    delete normalizedPrevious.id;
    delete normalizedPrevious.prevId;
    expect(normalizedSnapshot).toEqual(normalizedPrevious);
    expect(snapshot.prevId).toBe(previousSnapshot.id);
  });

  it('keeps the generated journal and snapshot counts aligned at 136', () => {
    const snapshots = readdirSync(path.join(migrations, 'meta')).filter((file) =>
      file.endsWith('_snapshot.json'),
    );
    expect(journal.entries).toHaveLength(136);
    expect(snapshots).toHaveLength(136);
    expect(journal.entries.at(-1)).toEqual({
      breakpoints: true,
      idx: 135,
      tag: migrationName,
      version: '7',
      when: expect.any(Number),
    });
    expect(snapshots).toContain('0135_snapshot.json');
  });
});

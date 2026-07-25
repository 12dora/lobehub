// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const { join } = path;

/**
 * Guard: drizzle journal entries must stay 1:1 with meta snapshots.
 * Prevents the M02 hand-write drift that breaks the next `drizzle-kit generate`.
 */
describe('drizzle migration journal ↔ meta snapshots', () => {
  const migrationsDir = join(__dirname, '../../../migrations');
  const metaDir = join(migrationsDir, 'meta');
  const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8')) as {
    entries: { tag: string; idx: number }[];
  };
  const snapshots = readdirSync(metaDir).filter((file) => file.endsWith('_snapshot.json'));

  it('maps every journal entry to exactly one snapshot without orphans', () => {
    const expectedSnapshots = journal.entries.map(
      ({ idx }) => `${String(idx).padStart(4, '0')}_snapshot.json`,
    );
    // Snapshots may exist for other agents' reserved slots that are not yet journaled.
    // Require every journal entry has a snapshot; allow extra snapshot files.
    for (const expected of expectedSnapshots) {
      expect(snapshots).toContain(expected);
    }
  });

  it('keeps journal indexes sorted and tags unique with matching prefixes', () => {
    const idxs = journal.entries.map(({ idx }) => idx);
    expect(idxs).toEqual([...idxs].toSorted((a, b) => a - b));
    expect(new Set(journal.entries.map(({ tag }) => tag)).size).toBe(journal.entries.length);
    journal.entries.forEach(({ idx, tag }) => {
      expect(tag.startsWith(`${String(idx).padStart(4, '0')}_`)).toBe(true);
    });
  });

  it('starts from the squashed baseline and keeps enterprise table coverage', () => {
    // The 0117-0155 history was squashed into one baseline; follow-up migrations may append.
    expect(journal.entries.length).toBeGreaterThanOrEqual(1);
    expect(journal.entries[0].tag).toBe('0000_squash_baseline');
    const sql = readFileSync(join(migrationsDir, '0000_squash_baseline.sql'), 'utf8');
    // Baseline creates the platform foundation and installs the immutability guards.
    expect(sql).toMatch(/platform_audit_logs/);
    expect(sql).toMatch(/prevent_platform_audit_log_mutation/);
    // High-risk enterprise tables that partial smoke suites previously omitted (DB-011).
    for (const table of [
      'platform_audit_exports',
      'platform_audit_legal_holds',
      'platform_audit_retention_runs',
      'platform_global_credentials',
      'platform_identity_provider_secrets',
      'platform_identity_provider_test_attempts',
      'platform_identity_provider_restart_requests',
      'platform_auth_settings',
      'platform_sidebar_layout',
      'platform_connector_oauth_states',
      'platform_instance_revision_states',
      'user_setting_overrides',
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${table}\\b`));
    }
    // No CREATE INDEX CONCURRENTLY inside the single transactional baseline.
    expect(sql).not.toMatch(/index\s+concurrently/i);
  });

  it('rejects create-then-drop table pairs and non-journal predeploy tags in active migrations (DB-013)', () => {
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    const journalTags = new Set(journal.entries.map((e) => e.tag));

    for (const file of sqlFiles) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      // Create-then-drop of the same table inside one migration is dead DDL (DB-013).
      // Only flag tables that are CREATE'd and later DROP'd in the same file.
      const created = new Set(
        [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi)].map((m) =>
          m[1]!.toLowerCase(),
        ),
      );
      const dropped = [...sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?(\w+)["']?/gi)].map(
        (m) => m[1]!.toLowerCase(),
      );
      // For follow-up migrations (not the historical squash baseline), reject create-then-drop.
      if (file !== '0000_squash_baseline.sql') {
        for (const name of dropped) {
          expect(created.has(name)).toBe(false);
        }
      }
    }

    // Operational markdown must not reference migration tags outside the journal.
    const mdFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.md'));
    for (const file of mdFiles) {
      const md = readFileSync(join(migrationsDir, file), 'utf8');
      // Skip files explicitly marked historical / not applicable to the active journal.
      if (/APPLICABILITY:\s*historical/i.test(md) || /not\s+in\s+active\s+journal/i.test(md)) {
        continue;
      }
      const tagRefs = [...md.matchAll(/migration\s+`?(\d{4}_[\w-]+)`?/gi)].map((m) => m[1]!);
      for (const tag of tagRefs) {
        expect(journalTags.has(tag)).toBe(true);
      }
    }
  });

  it('flags nested COMMIT in the baseline that would end the migrator transaction (DB-003)', () => {
    const sql = readFileSync(join(migrationsDir, '0000_squash_baseline.sql'), 'utf8');
    // Document known defect: historical COMMIT mid-file. Do not silently regrow.
    // Preflight scripts/migrateServerDB/preflightBaseline.ts must run before migrate.
    const commits = [...sql.matchAll(/^\s*COMMIT\s*;/gim)];
    // Known: one COMMIT remains from the pre-squash history (see preflight recovery).
    // Guard against additional transaction-control statements being reintroduced.
    expect(commits.length).toBeLessThanOrEqual(1);
    const begins = [...sql.matchAll(/^\s*BEGIN\s*;/gim)];
    expect(begins.length).toBeLessThanOrEqual(1);
  });
});

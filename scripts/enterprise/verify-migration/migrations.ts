import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PoolClient } from 'pg';

import type { JournalEntry } from './baseline';
import { allJournalEntries } from './baseline';
import {
  BASELINE_MIGRATION_LAST_IDX,
  EXPAND_ONLY_PROTECTED_TABLES,
  MIGRATIONS_DIR,
} from './constants';

export interface AppliedMigrationSummary {
  appliedCount: number;
  firstTag: string | null;
  lastTag: string | null;
}

const splitStatements = (sql: string): string[] =>
  sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);

export const readMigrationSql = (repoRoot: string, tag: string): string =>
  readFileSync(join(repoRoot, MIGRATIONS_DIR, `${tag}.sql`), 'utf8');

export const applyMigrationEntries = async (
  client: PoolClient,
  repoRoot: string,
  entries: JournalEntry[],
): Promise<AppliedMigrationSummary> => {
  if (entries.length === 0) {
    return { appliedCount: 0, firstTag: null, lastTag: null };
  }

  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  for (const entry of entries) {
    const sql = readMigrationSql(repoRoot, entry.tag);
    for (const statement of splitStatements(sql)) {
      await client.query(statement);
    }
    // Hash is not used for execution ordering here; store tag-derived digest for auditability.
    const hash = `tag:${entry.tag}`;
    await client.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = $1
       )`,
      [hash, entry.idx],
    );
  }

  return {
    appliedCount: entries.length,
    firstTag: entries[0]?.tag ?? null,
    lastTag: entries.at(-1)?.tag ?? null,
  };
};

export const baselineEntries = (repoRoot: string): JournalEntry[] =>
  allJournalEntries(repoRoot).filter(({ idx }) => idx <= BASELINE_MIGRATION_LAST_IDX);

export const postBaselineEntries = (repoRoot: string): JournalEntry[] =>
  allJournalEntries(repoRoot).filter(({ idx }) => idx > BASELINE_MIGRATION_LAST_IDX);

/**
 * Expand-only invariant over post-baseline SQL text:
 * must not DROP protected core application tables.
 */
export const verifyExpandOnlyPostBaselineSql = (
  repoRoot: string,
): { match: boolean; scannedMigrations: number } => {
  const entries = postBaselineEntries(repoRoot);
  for (const entry of entries) {
    const sql = readMigrationSql(repoRoot, entry.tag);
    const normalized = sql.replaceAll(/\s+/g, ' ');
    for (const table of EXPAND_ONLY_PROTECTED_TABLES) {
      const dropTable = new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?["']?${table}["']?`, 'i');
      if (dropTable.test(normalized)) {
        return { match: false, scannedMigrations: entries.length };
      }
      const renameTable = new RegExp(`ALTER\\s+TABLE\\s+["']?${table}["']?\\s+RENAME\\s+TO`, 'i');
      if (renameTable.test(normalized)) {
        return { match: false, scannedMigrations: entries.length };
      }
    }
  }
  return { match: true, scannedMigrations: entries.length };
};

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as nodeMigrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool, PoolClient } from 'pg';

import type { JournalEntry } from './baseline';
import { allJournalEntries } from './baseline';
import {
  ACTIVE_BASELINE_ENTRY_COUNT,
  ACTIVE_FOUNDATION_ENTRY_COUNT,
  EXPAND_ONLY_PROTECTED_TABLES,
  MIGRATIONS_DIR,
} from './constants';

export interface OfficialMigrationMeta {
  folderMillis: number;
  hash: string;
  sql: string[];
  tag: string;
}

export interface AppliedMigrationSummary {
  appliedCount: number;
  firstTag: string | null;
  lastTag: string | null;
}

export interface MigrationJournalSnapshot {
  count: number;
  /** Ordered hash + created_at pairs from drizzle.__drizzle_migrations */
  entries: Array<{ createdAt: string; hash: string }>;
}

export const migrationsFolderFor = (repoRoot: string): string =>
  path.join(repoRoot, MIGRATIONS_DIR);

/**
 * Authoritative migration list: SHA-256 of SQL file body + journal `when` as folderMillis.
 */
export const loadOfficialMigrations = (repoRoot: string): OfficialMigrationMeta[] => {
  const folder = migrationsFolderFor(repoRoot);
  const journal = allJournalEntries(repoRoot);
  const raw = readMigrationFiles({ migrationsFolder: folder });
  if (raw.length !== journal.length) {
    throw new Error('Official migration count does not match journal entries');
  }
  return raw.map((migration, index) => {
    const tag = journal[index]!.tag;
    const sqlBody = readFileSync(path.join(folder, `${tag}.sql`), 'utf8');
    const expectedHash = createHash('sha256').update(sqlBody).digest('hex');
    if (migration.hash !== expectedHash) {
      throw new Error('Official migration hash mismatch');
    }
    if (migration.folderMillis !== journal[index]!.when) {
      throw new Error('Official migration folderMillis does not match journal.when');
    }
    return {
      folderMillis: migration.folderMillis,
      hash: migration.hash,
      sql: migration.sql,
      tag,
    };
  });
};

/** Proves the legacy tag:/idx journal semantics are not official. */
export const isLegacyTagIdxJournalStyle = (hash: string, createdAt: number): boolean =>
  hash.startsWith('tag:') || (Number.isInteger(createdAt) && createdAt >= 0 && createdAt < 10_000);

export const ensureDrizzleMigrationsTable = async (client: PoolClient): Promise<void> => {
  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
};

const applyOfficialMigration = async (
  client: PoolClient,
  migration: OfficialMigrationMeta,
): Promise<void> => {
  for (const statement of migration.sql) {
    const trimmed = statement.trim();
    if (trimmed) await client.query(trimmed);
  }
  await client.query(
    `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
    [migration.hash, migration.folderMillis],
  );
};

export const applyOfficialMigrationRange = async (
  client: PoolClient,
  repoRoot: string,
  fromIdxInclusive: number,
  toIdxInclusive: number,
): Promise<AppliedMigrationSummary> => {
  const migrations = loadOfficialMigrations(repoRoot);
  const slice = migrations.slice(fromIdxInclusive, toIdxInclusive + 1);
  if (slice.length === 0) {
    return { appliedCount: 0, firstTag: null, lastTag: null };
  }
  await ensureDrizzleMigrationsTable(client);
  for (const migration of slice) {
    await applyOfficialMigration(client, migration);
  }
  return {
    appliedCount: slice.length,
    firstTag: slice[0]?.tag ?? null,
    lastTag: slice.at(-1)?.tag ?? null,
  };
};

export const applyOfficialBaselineMigrations = async (
  client: PoolClient,
  repoRoot: string,
): Promise<AppliedMigrationSummary> =>
  applyOfficialMigrationRange(client, repoRoot, 0, ACTIVE_BASELINE_ENTRY_COUNT - 1);

export const applyOfficialPostBaselineMigrations = async (
  client: PoolClient,
  repoRoot: string,
): Promise<AppliedMigrationSummary> => {
  const total = loadOfficialMigrations(repoRoot).length;
  return applyOfficialMigrationRange(client, repoRoot, ACTIVE_BASELINE_ENTRY_COUNT, total - 1);
};

export const snapshotMigrationJournal = async (
  client: PoolClient,
): Promise<MigrationJournalSnapshot> => {
  const result = await client.query<{ created_at: string; hash: string }>(
    `SELECT hash, created_at::text AS created_at
     FROM "drizzle"."__drizzle_migrations"
     ORDER BY created_at ASC, id ASC`,
  );
  return {
    count: result.rows.length,
    entries: result.rows.map((row) => ({
      createdAt: row.created_at,
      hash: row.hash,
    })),
  };
};

export const migrationJournalSnapshotsEqual = (
  left: MigrationJournalSnapshot,
  right: MigrationJournalSnapshot,
): boolean => {
  if (left.count !== right.count) return false;
  if (left.entries.length !== right.entries.length) return false;
  return left.entries.every(
    (entry, index) =>
      entry.hash === right.entries[index]?.hash &&
      entry.createdAt === right.entries[index]?.createdAt,
  );
};

/**
 * Formal production migrator (drizzle-orm/node-postgres). On an already-upgraded
 * DB with correct hash/folderMillis rows this is a no-op; journal must be unchanged.
 */
export const runOfficialNodePostgresMigrator = async (
  pool: Pool,
  repoRoot: string,
): Promise<void> => {
  await runOfficialNodePostgresMigratorFromFolder(pool, migrationsFolderFor(repoRoot));
};

export const runOfficialNodePostgresMigratorFromFolder = async (
  pool: Pool,
  migrationsFolder: string,
): Promise<void> => {
  const db = drizzle(pool);
  await nodeMigrate(db, { migrationsFolder });
};

/**
 * Official rerun gate: migrator succeeds and journal count/content are unchanged.
 * Must not hold a PoolClient while migrate() runs — migrator needs its own connection.
 */
export const verifyOfficialMigratorRerun = async (
  pool: Pool,
  repoRoot: string,
): Promise<{ match: boolean; afterCount: number; beforeCount: number }> => {
  const beforeClient = await pool.connect();
  let before: MigrationJournalSnapshot;
  try {
    before = await snapshotMigrationJournal(beforeClient);
  } finally {
    beforeClient.release();
  }

  // Reject legacy tag/idx style rows — production migrator ordering depends on folderMillis.
  if (
    before.entries.some((entry) => isLegacyTagIdxJournalStyle(entry.hash, Number(entry.createdAt)))
  ) {
    return { afterCount: before.count, beforeCount: before.count, match: false };
  }

  await runOfficialNodePostgresMigrator(pool, repoRoot);

  const afterClient = await pool.connect();
  let after: MigrationJournalSnapshot;
  try {
    after = await snapshotMigrationJournal(afterClient);
  } finally {
    afterClient.release();
  }

  return {
    afterCount: after.count,
    beforeCount: before.count,
    match: migrationJournalSnapshotsEqual(before, after),
  };
};

export const countAppliedMigrations = async (client: PoolClient): Promise<number> => {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
  );
  return Number(result.rows[0]?.count ?? 0);
};

export const baselineEntries = (repoRoot: string): JournalEntry[] =>
  allJournalEntries(repoRoot).slice(0, ACTIVE_BASELINE_ENTRY_COUNT);

export const postBaselineEntries = (repoRoot: string): JournalEntry[] =>
  allJournalEntries(repoRoot).slice(ACTIVE_BASELINE_ENTRY_COUNT);

export const expandOnlyEntries = (repoRoot: string): JournalEntry[] =>
  allJournalEntries(repoRoot).slice(ACTIVE_FOUNDATION_ENTRY_COUNT);

export const readMigrationSql = (repoRoot: string, tag: string): string =>
  readFileSync(path.join(repoRoot, MIGRATIONS_DIR, `${tag}.sql`), 'utf8');

/** Strip SQL line/block comments before expand-only scanning. */
const stripSqlComments = (sql: string): string =>
  sql.replaceAll(/\/\*[\s\S]*?\*\//gu, ' ').replaceAll(/--[^\n]*/gu, ' ');

/** Reject top-level transaction control that can escape Drizzle's transaction. */
export const verifyNoTopLevelTransactionControl = (
  repoRoot: string,
): { match: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  for (const entry of allJournalEntries(repoRoot)) {
    const chunks = readMigrationSql(repoRoot, entry.tag).split('--> statement-breakpoint');
    for (const chunk of chunks) {
      const statement = stripSqlComments(chunk).trim();
      if (/^(?:BEGIN|COMMIT)\s*;?$/iu.test(statement)) {
        reasons.push(`${entry.tag}:top-level-transaction-control`);
      }
    }
  }
  return { match: reasons.length === 0, reasons };
};

/**
 * Conservative expand-only tokenizer over SQL text.
 * Rejects destructive contract changes on protected tables (and any DROP TABLE/COLUMN/CONSTRAINT/RENAME
 * that can break previous-app compatibility), including schema-qualified forms.
 */
export const scanExpandOnlySql = (sql: string): { match: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  const body = stripSqlComments(sql);
  // Split on statement terminators while keeping enough context for multi-line DDL.
  const statements = body
    .split(';')
    .map((part) => part.replaceAll(/\s+/gu, ' ').trim())
    .filter(Boolean);

  const protectedTable = (name: string): boolean => {
    const bare = name
      .replace(/^(?:public\.)?/iu, '')
      .replaceAll('"', '')
      .replaceAll("'", '');
    return (EXPAND_ONLY_PROTECTED_TABLES as readonly string[]).includes(bare.toLowerCase());
  };

  const ident = (raw: string): string => raw.replaceAll('"', '').replaceAll("'", '').toLowerCase();

  for (const statement of statements) {
    // DROP TABLE [IF EXISTS] [schema.]table
    const dropTable = statement.match(
      /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:"[^"]+"|'[^']+'|[a-z_]\w*)(?:\s*\.\s*(?:"[^"]+"|'[^']+'|[a-z_]\w*))?)/iu,
    );
    if (dropTable?.[1] && protectedTable(dropTable[1])) {
      reasons.push(`drop-table:${ident(dropTable[1])}`);
    }

    // ALTER TABLE … DROP COLUMN / DROP CONSTRAINT / RENAME / TYPE / SET NOT NULL / DROP NOT NULL
    // Use `\S.*` (not `.+`) after `\s+` so whitespace cannot trade with the tail capture (no super-linear backtracking).
    const alterMatch = statement.match(
      /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:"[^"]+"|'[^']+'|[a-z_]\w*)(?:\s*\.\s*(?:"[^"]+"|'[^']+'|[a-z_]\w*))?)\s+(\S.*)$/iu,
    );
    if (alterMatch?.[1] && protectedTable(alterMatch[1])) {
      const table = ident(alterMatch[1]);
      const tail = alterMatch[2] ?? '';
      const tailUpper = tail.toUpperCase();

      if (/\bDROP\s+COLUMN\b/iu.test(tail)) {
        reasons.push(`drop-column:${table}`);
      }
      if (/\bDROP\s+CONSTRAINT\b/iu.test(tail)) {
        reasons.push(`drop-constraint:${table}`);
      }
      if (/\bRENAME\s+(?:TO|COLUMN)\b/iu.test(tail) || /\bRENAME\s+CONSTRAINT\b/iu.test(tail)) {
        reasons.push(`rename:${table}`);
      }
      // Narrowing type change: ALTER COLUMN … TYPE …
      // `+?` (min 1) between COLUMN and TYPE avoids empty-match contradiction with `\b`.
      if (
        (/\bALTER\s+COLUMN\b[\s\S]+?\bTYPE\b/iu.test(tail) || /\bTYPE\b/iu.test(tailUpper)) && // Only flag TYPE when it is an ALTER COLUMN type change, not CREATE TYPE elsewhere.
        /\b(?:ALTER\s+COLUMN|COLUMN)\b[\s\S]+?\bTYPE\b/iu.test(tail)
      ) {
        reasons.push(`narrowing-type:${table}`);
      }
      // Nullability narrowing: SET NOT NULL (DROP NOT NULL is expand-safe)
      if (/\bSET\s+NOT\s+NULL\b/iu.test(tail)) {
        reasons.push(`narrowing-nullability:${table}`);
      }
    }

    // Standalone RENAME TABLE forms (less common)
    const renameTable = statement.match(
      /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:"[^"]+"|'[^']+'|[a-z_]\w*)(?:\s*\.\s*(?:"[^"]+"|'[^']+'|[a-z_]\w*))?)\s+RENAME\s+TO\b/iu,
    );
    if (
      renameTable?.[1] &&
      protectedTable(renameTable[1]) &&
      !reasons.includes(`rename:${ident(renameTable[1])}`)
    ) {
      reasons.push(`rename:${ident(renameTable[1])}`);
    }
  }

  // Extra conservative whole-body checks for multi-clause ALTER (comma-separated) missed by split.
  for (const table of EXPAND_ONLY_PROTECTED_TABLES) {
    const t = table.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const schemaTable = `(?:(?:public)\\s*\\.\\s*)?(?:"${t}"|'${t}'|${t})`;
    if (
      new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${schemaTable}\\b`, 'iu').test(body) &&
      !reasons.some((r) => r.startsWith('drop-table:') && r.includes(table))
    ) {
      reasons.push(`drop-table:${table}`);
    }
    if (
      new RegExp(
        `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${schemaTable}\\s+[\\s\\S]*?\\bDROP\\s+COLUMN\\b`,
        'iu',
      ).test(body) &&
      !reasons.includes(`drop-column:${table}`)
    ) {
      reasons.push(`drop-column:${table}`);
    }
  }

  return { match: reasons.length === 0, reasons };
};

/**
 * Expand-only invariant over SQL after the fresh baseline and compatibility
 * bridge. The bridge intentionally preserves historical contract migrations;
 * all subsequent migrations must remain expand-only.
 * reject destructive contract changes (DROP TABLE/COLUMN/CONSTRAINT, renames, narrowing).
 */
export const verifyExpandOnlyPostBaselineSql = (
  repoRoot: string,
): { match: boolean; scannedMigrations: number; reasons?: string[] } => {
  const entries = expandOnlyEntries(repoRoot);
  const allReasons: string[] = [];
  for (const entry of entries) {
    const sql = readMigrationSql(repoRoot, entry.tag);
    const result = scanExpandOnlySql(sql);
    if (!result.match) {
      allReasons.push(...result.reasons.map((reason) => `${entry.tag}:${reason}`));
    }
  }
  if (allReasons.length > 0) {
    return { match: false, reasons: allReasons, scannedMigrations: entries.length };
  }
  return { match: true, scannedMigrations: entries.length };
};

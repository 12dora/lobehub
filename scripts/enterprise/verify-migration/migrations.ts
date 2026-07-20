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
  BASELINE_MIGRATION_LAST_IDX,
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
  applyOfficialMigrationRange(client, repoRoot, 0, BASELINE_MIGRATION_LAST_IDX);

export const applyOfficialPostBaselineMigrations = async (
  client: PoolClient,
  repoRoot: string,
): Promise<AppliedMigrationSummary> => {
  const total = loadOfficialMigrations(repoRoot).length;
  return applyOfficialMigrationRange(client, repoRoot, BASELINE_MIGRATION_LAST_IDX + 1, total - 1);
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
  const db = drizzle(pool);
  await nodeMigrate(db, { migrationsFolder: migrationsFolderFor(repoRoot) });
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
  allJournalEntries(repoRoot).filter(({ idx }) => idx <= BASELINE_MIGRATION_LAST_IDX);

export const postBaselineEntries = (repoRoot: string): JournalEntry[] =>
  allJournalEntries(repoRoot).filter(({ idx }) => idx > BASELINE_MIGRATION_LAST_IDX);

export const readMigrationSql = (repoRoot: string, tag: string): string =>
  readFileSync(path.join(repoRoot, MIGRATIONS_DIR, `${tag}.sql`), 'utf8');

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

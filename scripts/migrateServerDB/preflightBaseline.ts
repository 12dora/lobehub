/**
 * Preflight for the squashed baseline migration (DB-003).
 *
 * The active `0000_squash_baseline.sql` still contains a historical mid-file
 * `COMMIT` copied from pre-squash history. Drizzle wraps pending migrations in
 * `session.transaction`; that inner COMMIT ends the outer transaction early, so
 * a later failure leaves committed DDL without a journal row.
 *
 * Until the next controlled disposable-baseline cut, this preflight:
 * 1. Validates every required PostgreSQL extension is available.
 * 2. Prints an explicit recovery instruction if a partial install is detected.
 *
 * Usage (before migrate):
 *   bun scripts/migrateServerDB/preflightBaseline.ts
 */
import { Pool } from 'pg';

/**
 * Extensions the squashed baseline installs *without* an EXCEPTION guard.
 *
 * Derived from `packages/database/migrations/0000_squash_baseline.sql`:
 * - `vector`   — CREATE EXTENSION before mid-file COMMIT (rollback-safe, but required at runtime)
 * - `pg_search` — CREATE EXTENSION after mid-file COMMIT (unguarded; this is the late-failure risk)
 *
 * Do NOT require `pg_trgm` — baseline wraps it in DO $$ … EXCEPTION WHEN OTHERS.
 * Do NOT require `uuid-ossp` / `pgcrypto` — baseline never creates them.
 */
export const REQUIRED_BASELINE_EXTENSIONS = ['vector', 'pg_search'] as const;

export const PARTIAL_BASELINE_RECOVERY_HINT = `
================================================================================
BASELINE MIGRATION RECOVERY (DB-003)
================================================================================
A partial schema may exist without a drizzle journal row if the squashed
baseline committed mid-file (historical COMMIT) and a later statement failed.

Recovery for disposable / self-hosted installs:
  1. DROP the database (or schema) and recreate it empty.
  2. Re-run: bun scripts/migrateServerDB/preflightBaseline.ts
  3. Re-run: bun scripts/migrateServerDB/index.ts

Do NOT retry migrate against a half-applied schema — unguarded CREATE TABLE
statements will fail on already-committed objects.
================================================================================
`.trim();

export interface PreflightBaselineResult {
  missingExtensions: string[];
  ok: boolean;
  partialInstallDetected: boolean;
}

/**
 * Pure check used by tests and the CLI. Pass query helpers so unit tests do not
 * need a live Postgres connection.
 */
export const evaluateBaselinePreflight = async (params: {
  extensionAvailable: (name: string) => Promise<boolean>;
  /** True when core tables exist but drizzle.__drizzle_migrations has no baseline row. */
  isPartialInstall: () => Promise<boolean>;
  requiredExtensions?: readonly string[];
}): Promise<PreflightBaselineResult> => {
  const required = params.requiredExtensions ?? REQUIRED_BASELINE_EXTENSIONS;
  const missingExtensions: string[] = [];
  for (const name of required) {
    if (!(await params.extensionAvailable(name))) missingExtensions.push(name);
  }
  const partialInstallDetected = await params.isPartialInstall();
  return {
    missingExtensions,
    ok: missingExtensions.length === 0 && !partialInstallDetected,
    partialInstallDetected,
  };
};

const runCli = async (): Promise<void> => {
  const connectionString =
    process.env.TEST_SERVER_DB === '1' ? process.env.DATABASE_TEST_URL : process.env.DATABASE_URL;
  if (!connectionString) {
    console.log('🟢 no DATABASE_URL — baseline preflight skipped');
    process.exit(0);
  }

  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const result = await evaluateBaselinePreflight({
      extensionAvailable: async (name) => {
        // Prefer pg_available_extensions so we fail before CREATE EXTENSION.
        const res = await client.query<{ installed: boolean; name: string }>(
          `SELECT name, installed_version IS NOT NULL AS installed
           FROM pg_available_extensions
           WHERE name = $1`,
          [name],
        );
        if (res.rows.length === 0) return false;
        // Available is enough for preflight — migrate will CREATE EXTENSION.
        return true;
      },
      isPartialInstall: async () => {
        const tables = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'ai_models'
           ) AS exists`,
        );
        if (!tables.rows[0]?.exists) return false;
        const journal = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
           ) AS exists`,
        );
        if (!journal.rows[0]?.exists) return true;
        const rows = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`,
        );
        return Number(rows.rows[0]?.n ?? 0) === 0;
      },
    });

    if (result.missingExtensions.length > 0) {
      console.error(
        '❌ Required PostgreSQL extensions are not available:',
        result.missingExtensions.join(', '),
      );
      console.error(
        'Install them on the server (e.g. postgresql-*-pgvector) before running migrations.',
      );
      process.exit(1);
    }

    if (result.partialInstallDetected) {
      console.error('❌ Partial baseline install detected (schema objects without journal row).');
      console.error(PARTIAL_BASELINE_RECOVERY_HINT);
      process.exit(1);
    }

    console.log('✅ baseline preflight passed (extensions available, no partial install)');
    process.exit(0);
  } finally {
    client.release();
    await pool.end();
  }
};

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('preflightBaseline.ts')
) {
  void runCli().catch((err) => {
    console.error('❌ baseline preflight failed:', err);
    console.error(PARTIAL_BASELINE_RECOVERY_HINT);
    process.exit(1);
  });
}

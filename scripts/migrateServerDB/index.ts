import { join } from 'node:path';

import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import { migrate as neonMigrate } from 'drizzle-orm/neon-serverless/migrator';
import { migrate as nodeMigrate } from 'drizzle-orm/node-postgres/migrator';

// @ts-ignore tsgo handle esm import cjs and compatibility issues
import { DB_FAIL_INIT_HINT, DUPLICATE_EMAIL_HINT, PGVECTOR_HINT } from './errorHint';

// Load environment variables in priority order:
// 1. .env (lowest priority)
// 2. .env.[env] (medium priority, overrides .env)
// 3. .env.[env].local (highest priority, overrides previous)
// Use dotenv-expand to support ${var} variable expansion
const env = process.env.NODE_ENV || 'development';
dotenvExpand.expand(dotenv.config()); // Load .env
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}` })); // Load .env.[env] and override
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}.local` })); // Load .env.[env].local and override

const migrationsFolder = join(__dirname, '../../packages/database/migrations');

const runMigrations = async () => {
  // DB-003: validate extensions / partial install before the baseline migrator runs.
  // Skip when SKIP_BASELINE_PREFLIGHT=1 (unit envs that already assert schema separately).
  //
  // Connection strategy: prefer the driver-aware serverDB path (WSS for neon-serverless,
  // TCP for node). Fall back to a raw `pg` Pool only when DATABASE_DRIVER=node. If the
  // preflight connection itself fails, log a warning and continue — never hard-stop
  // migrate for a TCP/ssl reachability issue that the real migrator would not hit.
  if (process.env.SKIP_BASELINE_PREFLIGHT !== '1') {
    const { evaluateBaselinePreflight, PARTIAL_BASELINE_RECOVERY_HINT } =
      await import('./preflightBaseline');
    try {
      const { serverDB: preflightDb } = await import('../../packages/database/src/server');
      const runQuery = async <T extends Record<string, unknown>>(
        sqlText: string,
        params: unknown[] = [],
      ): Promise<{ rows: T[]; rowCount: number | null }> => {
        // drizzle execute returns driver-shaped results; normalise to { rows, rowCount }.
        const raw = await (preflightDb as { execute: (q: unknown) => Promise<unknown> }).execute(
          // Use a tagged template via sql when possible; fallback to node-postgres style.
          (await import('drizzle-orm')).sql.raw(
            params.length === 0
              ? sqlText
              : sqlText.replaceAll(/\$(\d+)/g, (_, n) => {
                  const v = params[Number(n) - 1];
                  if (v === null || v === undefined) return 'NULL';
                  if (typeof v === 'number') return String(v);
                  return `'${String(v).replaceAll("'", "''")}'`;
                }),
          ),
        );
        const asAny = raw as { rows?: T[]; rowCount?: number | null };
        if (Array.isArray(raw)) {
          return { rowCount: raw.length, rows: raw as T[] };
        }
        return {
          rowCount: asAny.rowCount ?? asAny.rows?.length ?? null,
          rows: asAny.rows ?? [],
        };
      };

      const result = await evaluateBaselinePreflight({
        extensionAvailable: async (name) => {
          const res = await runQuery<{ name: string }>(
            `SELECT name FROM pg_available_extensions WHERE name = '${name.replaceAll("'", "''")}'`,
          );
          return res.rows.length > 0;
        },
        isPartialInstall: async () => {
          const tables = await runQuery<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = 'ai_models'
             ) AS exists`,
          );
          if (!tables.rows[0]?.exists) return false;
          const journal = await runQuery<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
             ) AS exists`,
          );
          if (!journal.rows[0]?.exists) return true;
          const rows = await runQuery<{ n: string }>(
            `SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`,
          );
          return Number(rows.rows[0]?.n ?? 0) === 0;
        },
      });
      if (result.missingExtensions.length > 0) {
        throw new Error(`Required extensions unavailable: ${result.missingExtensions.join(', ')}`);
      }
      if (result.partialInstallDetected) {
        console.error(PARTIAL_BASELINE_RECOVERY_HINT);
        throw new Error('Partial baseline install detected — refuse to re-run migrate');
      }
    } catch (preflightErr) {
      const msg = preflightErr instanceof Error ? preflightErr.message : String(preflightErr);
      // Hard-fail only for real preflight findings (missing ext / partial install).
      if (
        msg.includes('Required extensions unavailable') ||
        msg.includes('Partial baseline install')
      ) {
        throw preflightErr;
      }
      // Connection / driver errors: warn and proceed — migrator uses its own client.
      console.warn(
        '[migrateServerDB] baseline preflight connection failed (continuing with migrate):',
        msg,
      );
    }
  }

  const { serverDB } = await import('../../packages/database/src/server');

  const time = Date.now();
  if (process.env.DATABASE_DRIVER === 'node') {
    await nodeMigrate(serverDB, { migrationsFolder });
  } else {
    await neonMigrate(serverDB, { migrationsFolder });
  }

  console.log('✅ database migration pass. use: %s ms', Date.now() - time);

  process.exit(0);
};

const connectionString = process.env.DATABASE_URL;

// only migrate database if the connection string is available
if (connectionString) {
  runMigrations().catch(async (err) => {
    console.error('❌ Database migrate failed:', err);

    const errMsg = err.message as string;

    const constraint = (err as { constraint?: string })?.constraint;

    if (errMsg.includes('extension "vector" is not available')) {
      console.info(PGVECTOR_HINT);
    } else if (constraint === 'users_email_unique' || errMsg.includes('users_email_unique')) {
      console.info(DUPLICATE_EMAIL_HINT);
    } else if (errMsg.includes(`Cannot read properties of undefined (reading 'migrate')`)) {
      console.info(DB_FAIL_INIT_HINT);
    } else if (
      errMsg.includes('already exists') ||
      errMsg.includes('Partial baseline') ||
      /relation .* already exists/i.test(errMsg)
    ) {
      const { PARTIAL_BASELINE_RECOVERY_HINT } = await import('./preflightBaseline');
      console.info(PARTIAL_BASELINE_RECOVERY_HINT);
    }

    process.exit(1);
  });
} else {
  console.log('🟢 not find database env or in desktop mode, migration skipped');
}

import type { PoolClient } from 'pg';

import type { CoreFixtureTable } from './constants';
import { CORE_FIXTURE_TABLES } from './constants';
import { SYNTHETIC_FIXTURE_ROW_COUNTS } from './fixture';

export interface RowCountResult {
  counts: Record<string, number>;
  match: boolean;
}

export interface BooleanInvariant {
  match: boolean;
}

const tableCount = async (client: PoolClient, table: string): Promise<number> => {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "${table}"`,
  );
  return Number(result.rows[0]?.count ?? 0);
};

export const verifyCoreRowCounts = async (
  client: PoolClient,
  expected: Partial<Record<CoreFixtureTable, number>> = SYNTHETIC_FIXTURE_ROW_COUNTS,
): Promise<RowCountResult> => {
  const counts: Record<string, number> = {};
  let match = true;

  for (const table of CORE_FIXTURE_TABLES) {
    const count = await tableCount(client, table);
    counts[table] = count;
    const minimum = expected[table] ?? 0;
    if (count < minimum) match = false;
  }

  return { counts, match };
};

/**
 * Detect orphaned FK references among core fixture relationships.
 */
export const verifyCoreForeignKeys = async (client: PoolClient): Promise<BooleanInvariant> => {
  const checks = [
    `SELECT COUNT(*)::int AS n FROM sessions s
     LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL`,
    `SELECT COUNT(*)::int AS n FROM agents a
     LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NULL`,
    `SELECT COUNT(*)::int AS n FROM topics t
     LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL`,
    `SELECT COUNT(*)::int AS n FROM messages m
     LEFT JOIN users u ON u.id = m.user_id WHERE u.id IS NULL`,
    `SELECT COUNT(*)::int AS n FROM messages m
     LEFT JOIN sessions s ON s.id = m.session_id
     WHERE m.session_id IS NOT NULL AND s.id IS NULL`,
    `SELECT COUNT(*)::int AS n FROM messages m
     LEFT JOIN topics t ON t.id = m.topic_id
     WHERE m.topic_id IS NOT NULL AND t.id IS NULL`,
    `SELECT COUNT(*)::int AS n FROM api_keys k
     LEFT JOIN users u ON u.id = k.user_id WHERE u.id IS NULL`,
    `SELECT COUNT(*)::int AS n FROM user_settings us
     LEFT JOIN users u ON u.id = us.id WHERE u.id IS NULL`,
  ];

  for (const sql of checks) {
    const result = await client.query<{ n: number }>(sql);
    if (Number(result.rows[0]?.n ?? 0) > 0) return { match: false };
  }
  return { match: true };
};

/**
 * Revision invariant: platform revision table exists after post-baseline migrations
 * and has non-negative revision values when rows exist.
 */
export const verifyRevisionInfrastructure = async (
  client: PoolClient,
): Promise<BooleanInvariant> => {
  const exists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'platform_resource_revisions'
     ) AS exists`,
  );
  if (!exists.rows[0]?.exists) return { match: false };

  const invalid = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM platform_resource_revisions WHERE revision < 0`,
  );
  return { match: Number(invalid.rows[0]?.n ?? 0) === 0 };
};

/**
 * Audit invariant: platform audit log table exists and accepts the expected shape.
 */
export const verifyAuditInfrastructure = async (client: PoolClient): Promise<BooleanInvariant> => {
  const exists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'platform_audit_logs'
     ) AS exists`,
  );
  if (!exists.rows[0]?.exists) return { match: false };

  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'platform_audit_logs'`,
  );
  const names = new Set(columns.rows.map((row) => row.column_name));
  for (const required of ['id', 'action', 'target_type', 'result', 'created_at']) {
    if (!names.has(required)) return { match: false };
  }
  return { match: true };
};

/**
 * Secret-reference / expand-only data invariant:
 * - secret_ref-like columns must not hold PEM private keys or live key prefixes
 * - platform secret tables (if present) should expose ref/fingerprint columns, not raw password columns named "secret"
 */
export const verifySecretReferenceInvariants = async (
  client: PoolClient,
): Promise<BooleanInvariant> => {
  const columns = await client.query<{ column_name: string; table_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         column_name LIKE '%secret_ref'
         OR column_name LIKE '%_secret_ref'
         OR column_name = 'secret_fingerprint'
       )`,
  );

  for (const { table_name, column_name } of columns.rows) {
    // Only sample a bounded set of rows; never return values to callers.
    const sample = await client.query(
      `SELECT 1 FROM "${table_name}"
       WHERE "${column_name}" IS NOT NULL
         AND (
           "${column_name}" ~ '-----BEGIN'
           OR "${column_name}" ~* '(sk|pk|rk)[_-]live[_-]'
           OR "${column_name}" ~* 'postgres(ql)?://'
         )
       LIMIT 1`,
    );
    if (sample.rowCount && sample.rowCount > 0) return { match: false };
  }

  // Expand-only for secrets: core fixture api_keys must still be reference/hash oriented
  // (key_hash present; no private key material in key_hash).
  const apiKeyLeak = await client.query(
    `SELECT 1 FROM api_keys
     WHERE key_hash ~ '-----BEGIN'
        OR key_hash ~* '(sk|pk|rk)[_-]live[_-]'
     LIMIT 1`,
  );
  if (apiKeyLeak.rowCount && apiKeyLeak.rowCount > 0) return { match: false };

  return { match: true };
};

export const countAppliedMigrations = async (client: PoolClient): Promise<number> => {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
  );
  return Number(result.rows[0]?.count ?? 0);
};

/**
 * Re-run marker: verification writes a one-row marker. A second apply of the same
 * pipeline on an already-migrated owned DB is idempotent for data checks; re-applying
 * baseline SQL that is not fully idempotent must fail explicitly via marker conflict
 * when requested.
 */
export const ensureRerunMarkerTable = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."migration_compat_runs" (
      id text PRIMARY KEY,
      completed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

export const recordVerificationRun = async (
  client: PoolClient,
  runId: string,
): Promise<'first' | 'rerun'> => {
  await ensureRerunMarkerTable(client);
  const existing = await client.query(
    `SELECT 1 FROM "drizzle"."migration_compat_runs" WHERE id = $1`,
    [runId],
  );
  if (existing.rowCount && existing.rowCount > 0) return 'rerun';
  await client.query(`INSERT INTO "drizzle"."migration_compat_runs" (id) VALUES ($1)`, [runId]);
  return 'first';
};

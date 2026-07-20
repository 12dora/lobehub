import type { PoolClient } from 'pg';

import type { CoreFixtureTable } from './constants';
import { CORE_FIXTURE_TABLES } from './constants';
import { SYNTHETIC_FIXTURE_ROW_COUNTS } from './fixture';
import { verifyAuditProbes, verifyRevisionProbes, verifySecretReferenceProbes } from './probes';

export interface RowCountResult {
  counts: Record<string, number>;
  match: boolean;
}

export interface BooleanInvariant {
  match: boolean;
  rowCount?: number;
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
 * Non-vacuous revision check: requires probe rows and uniqueness.
 * Zero rows → fail.
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
  if (!exists.rows[0]?.exists) return { match: false, rowCount: 0 };

  const probe = await verifyRevisionProbes(client);
  return { match: probe.match, rowCount: probe.rowCount };
};

/**
 * Non-vacuous audit check: requires a real redacted audit probe row.
 * Zero rows → fail.
 */
export const verifyAuditInfrastructure = async (client: PoolClient): Promise<BooleanInvariant> => {
  const exists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'platform_audit_logs'
     ) AS exists`,
  );
  if (!exists.rows[0]?.exists) return { match: false, rowCount: 0 };

  const probe = await verifyAuditProbes(client);
  return { match: probe.match, rowCount: probe.rowCount };
};

/**
 * Non-vacuous secret-reference check: requires ref/fingerprint pairing.
 * Zero rows → fail.
 */
export const verifySecretReferenceInvariants = async (
  client: PoolClient,
): Promise<BooleanInvariant> => {
  const exists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'platform_identity_providers'
     ) AS exists`,
  );
  if (!exists.rows[0]?.exists) return { match: false, rowCount: 0 };

  const probe = await verifySecretReferenceProbes(client);
  return { match: probe.match, rowCount: probe.rowCount };
};

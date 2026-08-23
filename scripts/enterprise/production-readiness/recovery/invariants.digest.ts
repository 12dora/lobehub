import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { RECOVERY_ENTERPRISE_TABLES } from '../inventory';
import { canonicalize } from '../trust/canonical';
import type { AggregateDigestResult, TableDigestEntry } from './invariants.types';

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const TABLE_DIGEST_ENCODING_VERSION = 1 as const;

/**
 * Shared versioned encoder for every recovery authorization digest.
 * Uses recursive canonicalize (sorted nested keys; preserves nested structure).
 * Never uses JSON.stringify replacer-array (which drops nested keys).
 */
export const digestCanonicalRecords = (
  kind: string,
  records: ReadonlyArray<Record<string, unknown>>,
): string => {
  const serialized = records
    .map((record) => canonicalize(record))
    .sort((a, b) => a.localeCompare(b, 'en'));
  return sha256Hex(
    canonicalize({
      encodingVersion: TABLE_DIGEST_ENCODING_VERSION,
      kind,
      recordCount: serialized.length,
      records: serialized,
    }),
  );
};

/** SHA-256 of recursive canonical JSON (nested objects preserved). */
export const digestCanonicalValue = (value: unknown): string => sha256Hex(canonicalize(value));

export const digestResourceRevisions = async (
  client: PoolClient,
): Promise<AggregateDigestResult> => {
  const result = await client.query<{
    checksum: string;
    id: string;
    resource_id: string;
    resource_type: string;
    revision: string;
    status: string;
  }>(
    `SELECT id, resource_type, resource_id, revision::text AS revision, status, checksum
     FROM platform_resource_revisions`,
  );
  const records = result.rows.map((row) => ({
    checksum: row.checksum,
    id: row.id,
    resource_id: row.resource_id,
    resource_type: row.resource_type,
    revision: row.revision,
    status: row.status,
  }));
  return {
    digest: digestCanonicalRecords('resource-revisions', records),
    match: true,
    rowCount: result.rows.length,
  };
};

export const digestAuditLogs = async (client: PoolClient): Promise<AggregateDigestResult> => {
  const result = await client.query<{
    action: string;
    after_diff: unknown;
    config_revision: string | null;
    id: string;
    result: string;
    target_id: string | null;
    target_type: string | null;
  }>(
    `SELECT id, action, result, target_type, target_id,
            config_revision::text AS config_revision,
            after_diff
     FROM platform_audit_logs`,
  );
  const records = result.rows.map((row) => {
    let diffDigest: string | null = null;
    if (row.after_diff !== null && row.after_diff !== undefined) {
      // Recursive canonical JSON then SHA-256 — never emit raw diff; preserve nested keys.
      const stable =
        typeof row.after_diff === 'string' ? row.after_diff : canonicalize(row.after_diff);
      diffDigest = sha256Hex(stable);
    }
    return {
      action: row.action,
      config_revision: row.config_revision,
      diff_digest: diffDigest,
      id: row.id,
      result: row.result,
      target_id: row.target_id,
      target_type: row.target_type,
    };
  });
  return {
    digest: digestCanonicalRecords('audit-logs', records),
    match: true,
    rowCount: result.rows.length,
  };
};

/**
 * Canonical per-table digests (encoding v1): unambiguous JSON projection.
 * Never concatenate with unescaped delimiters (pipe/newline collisions).
 * Secret-bearing values are pre-hashed; never emitted raw.
 */
const SECRETISH_COLUMN = /secret|cipher|password|token|key_vault|fingerprint|ref$/iu;

const normalizeCell = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // Recursive canonical JSON string (nested keys preserved and sorted).
    try {
      return canonicalize(value);
    } catch {
      // Non-plain objects (e.g. Buffer handled below)
      if (Buffer.isBuffer(value)) return value.toString('base64');
      return String(value);
    }
  }
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return String(value);
};

/** Build one row's canonical projection (fixed column order + typed nulls). */
export const canonicalizeTableRow = (
  columns: ReadonlyArray<{ name: string; dataType: string }>,
  row: Record<string, unknown>,
): string => {
  const cells = columns.map((col) => {
    const raw = row[col.name];
    if (raw === null || raw === undefined) {
      return { c: col.name, k: 'null' as const, t: col.dataType };
    }
    if (SECRETISH_COLUMN.test(col.name)) {
      return {
        c: col.name,
        d: sha256Hex(String(raw)),
        k: 'secret' as const,
        t: col.dataType,
      };
    }
    return {
      c: col.name,
      k: 'plain' as const,
      t: col.dataType,
      v: normalizeCell(raw),
    };
  });
  return JSON.stringify(cells);
};

export const digestAllRequiredTables = async (
  client: PoolClient,
  tables: readonly string[] = RECOVERY_ENTERPRISE_TABLES,
): Promise<TableDigestEntry[]> => {
  const entries: TableDigestEntry[] = [];
  for (const table of tables) {
    const cols = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );
    if (cols.rows.length === 0) {
      entries.push({ digest: sha256Hex(`missing:${table}`), name: table, rowCount: -1 });
      continue;
    }
    const columns = cols.rows.map((c) => ({ dataType: c.data_type, name: c.column_name }));
    const quoted = columns.map((c) => `"${c.name}"`).join(', ');
    // Cursor-style chunked read to avoid holding unbounded driver buffers for huge tables.
    // Canonical digest still sorts all row encodings (deterministic encoding contract).
    const CHUNK = 500;
    const rowCanonicals: string[] = [];
    let offset = 0;
    for (;;) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${quoted} FROM "${table}" ORDER BY 1 OFFSET $1 LIMIT $2`,
        [offset, CHUNK],
      );
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        rowCanonicals.push(canonicalizeTableRow(columns, row));
      }
      offset += result.rows.length;
      if (result.rows.length < CHUNK) break;
    }
    rowCanonicals.sort((a, b) => a.localeCompare(b, 'en'));
    const payload = {
      columns: columns.map((c) => ({ name: c.name, type: c.dataType })),
      encodingVersion: TABLE_DIGEST_ENCODING_VERSION,
      rowCount: rowCanonicals.length,
      rows: rowCanonicals,
      table,
    };
    entries.push({
      digest: sha256Hex(JSON.stringify(payload)),
      name: table,
      rowCount: rowCanonicals.length,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
};

export const compareTableDigests = (
  before: TableDigestEntry[],
  after: TableDigestEntry[],
): boolean => {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i += 1) {
    if (
      before[i]!.name !== after[i]!.name ||
      before[i]!.digest !== after[i]!.digest ||
      before[i]!.rowCount !== after[i]!.rowCount ||
      before[i]!.rowCount < 0
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Full post-restore invariants: tables digests, secrets, publications, audits.
 */
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { PUBLICATION_POINTER_SOURCES, RECOVERY_ENTERPRISE_TABLES } from '../inventory';

export interface AggregateDigestResult {
  digest: string;
  match: boolean;
  rowCount: number;
}

export interface BooleanInvariant {
  detail?: string;
  match: boolean;
}

export interface TableDigestEntry {
  digest: string;
  name: string;
  rowCount: number;
}

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

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
     FROM platform_resource_revisions
     ORDER BY resource_type, resource_id, revision, id`,
  );
  const lines = result.rows.map(
    (row) =>
      `${row.id}|${row.resource_type}|${row.resource_id}|${row.revision}|${row.status}|${row.checksum}`,
  );
  return { digest: sha256Hex(lines.join('\n')), match: true, rowCount: result.rows.length };
};

export const digestAuditLogs = async (client: PoolClient): Promise<AggregateDigestResult> => {
  const result = await client.query<{
    action: string;
    config_revision: string | null;
    diff_digest: string | null;
    id: string;
    result: string;
    target_id: string | null;
    target_type: string | null;
  }>(
    `SELECT id, action, result, target_type, target_id,
            config_revision::text AS config_revision,
            CASE WHEN after_diff IS NULL THEN NULL ELSE md5(after_diff::text) END AS diff_digest
     FROM platform_audit_logs
     ORDER BY id`,
  );
  const lines = result.rows.map(
    (row) =>
      `${row.id}|${row.action}|${row.result}|${row.target_type ?? ''}|${row.target_id ?? ''}|${row.config_revision ?? ''}|${row.diff_digest ?? ''}`,
  );
  return { digest: sha256Hex(lines.join('\n')), match: true, rowCount: result.rows.length };
};

/**
 * Canonical per-table digests (encoding v1): unambiguous JSON projection.
 * Never concatenate with unescaped delimiters (pipe/newline collisions).
 * Secret-bearing values are pre-hashed; never emitted raw.
 */
const SECRETISH_COLUMN = /secret|cipher|password|token|key_vault|fingerprint|ref$/iu;
export const TABLE_DIGEST_ENCODING_VERSION = 1 as const;

const normalizeCell = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // Stable JSON (sorted keys recursively)
    return JSON.stringify(value, (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, 'en')),
        );
      }
      return v;
    });
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
    const result = await client.query<Record<string, unknown>>(`SELECT ${quoted} FROM "${table}"`);
    const rowCanonicals = result.rows
      .map((row) => canonicalizeTableRow(columns, row))
      .sort((a, b) => a.localeCompare(b, 'en'));
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

export const verifySecretReferenceDomains = async (
  client: PoolClient,
): Promise<{
  aggregateDigest: string;
  dangling: boolean;
  match: boolean;
  domains: Record<string, { historyCount: number; referenceCount: number; match: boolean }>;
}> => {
  const digestParts: string[] = [];
  let dangling = false;
  let match = true;
  const domains: Record<string, { historyCount: number; referenceCount: number; match: boolean }> =
    {};

  const idp = await client.query<{ fingerprint: string | null; id: string; ref: string | null }>(
    `SELECT id, secret_ref AS ref, secret_fingerprint AS fingerprint
     FROM platform_identity_providers ORDER BY id`,
  );
  const idph = await client.query<{
    ciphertext: string;
    fingerprint: string;
    id: string;
    key_id: string;
    provider_id: string;
    ref: string;
  }>(
    `SELECT id, provider_id, fingerprint, ref, ciphertext, key_id
     FROM platform_identity_provider_secrets ORDER BY id`,
  );
  const idpDangling = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM platform_identity_provider_secrets h
     LEFT JOIN platform_identity_providers p ON p.id = h.provider_id WHERE p.id IS NULL`,
  );
  if (Number(idpDangling.rows[0]?.n ?? 0) > 0) {
    dangling = true;
    match = false;
  }
  let identityMatch = !dangling;
  for (const provider of idp.rows) {
    const refDigest = provider.ref ? sha256Hex(provider.ref) : '';
    digestParts.push(`idp:${provider.id}:${refDigest}:${provider.fingerprint ?? ''}`);
    if (provider.ref || provider.fingerprint) {
      const history = idph.rows.filter((row) => row.provider_id === provider.id);
      if (history.length < 1) identityMatch = false;
      for (const h of history) {
        if (provider.fingerprint && h.fingerprint !== provider.fingerprint) identityMatch = false;
        if (provider.ref && h.ref !== provider.ref) identityMatch = false;
        digestParts.push(
          `idph:${h.id}:${h.provider_id}:${h.fingerprint}:${sha256Hex(h.ref)}:${sha256Hex(h.ciphertext)}:${sha256Hex(h.key_id)}`,
        );
      }
    }
  }
  domains.identity = {
    historyCount: idph.rows.length,
    match: identityMatch,
    referenceCount: idp.rows.filter((r) => r.ref).length,
  };
  if (!identityMatch) match = false;

  const aip = await client.query<{ fingerprint: string | null; id: string; key_id: string | null }>(
    `SELECT id, secret_fingerprint AS fingerprint, secret_key_id AS key_id
     FROM platform_ai_providers ORDER BY id`,
  );
  const aih = await client.query<{
    ciphertext: string;
    fingerprint: string;
    id: string;
    key_id: string;
    provider_id: string;
  }>(
    `SELECT id, provider_id, fingerprint, ciphertext, key_id
     FROM platform_ai_provider_secrets ORDER BY id`,
  );
  const aiDangling = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM platform_ai_provider_secrets h
     LEFT JOIN platform_ai_providers p ON p.id = h.provider_id WHERE p.id IS NULL`,
  );
  if (Number(aiDangling.rows[0]?.n ?? 0) > 0) {
    dangling = true;
    match = false;
  }
  let aiMatch = !dangling;
  for (const provider of aip.rows) {
    digestParts.push(
      `ai:${provider.id}:${provider.fingerprint ?? ''}:${provider.key_id ? sha256Hex(provider.key_id) : ''}`,
    );
    if (provider.fingerprint) {
      const history = aih.rows.filter((row) => row.provider_id === provider.id);
      if (history.length < 1) aiMatch = false;
      for (const h of history) {
        if (h.fingerprint !== provider.fingerprint) aiMatch = false;
        digestParts.push(
          `aih:${h.id}:${h.provider_id}:${h.fingerprint}:${sha256Hex(h.ciphertext)}:${sha256Hex(h.key_id)}`,
        );
      }
    }
  }
  domains.ai = {
    historyCount: aih.rows.length,
    match: aiMatch,
    referenceCount: aip.rows.filter((r) => r.fingerprint).length,
  };
  if (!aiMatch) match = false;

  const conn = await client.query<{
    id: string;
    oauth_fp: string | null;
    oauth_ref: string | null;
    shared_fp: string | null;
    shared_ref: string | null;
  }>(
    `SELECT id,
            shared_secret_ref AS shared_ref,
            shared_secret_fingerprint AS shared_fp,
            oauth_client_secret_ref AS oauth_ref,
            oauth_client_secret_fingerprint AS oauth_fp
     FROM platform_connectors ORDER BY id`,
  );
  const conh = await client.query<{
    ciphertext: string;
    connector_id: string | null;
    fingerprint: string;
    id: string;
    key_id: string;
  }>(
    `SELECT id, connector_id, fingerprint, ciphertext, key_id
     FROM platform_connector_secrets ORDER BY id`,
  );
  let connectorMatch = true;
  for (const c of conn.rows) {
    digestParts.push(
      `c:${c.id}:${c.shared_ref ? sha256Hex(c.shared_ref) : ''}:${c.shared_fp ?? ''}:${c.oauth_ref ? sha256Hex(c.oauth_ref) : ''}:${c.oauth_fp ?? ''}`,
    );
    const fps = [c.shared_fp, c.oauth_fp].filter(Boolean) as string[];
    if (fps.length > 0) {
      const history = conh.rows.filter((row) => row.connector_id === c.id);
      if (history.length < 1) connectorMatch = false;
      for (const h of history) {
        if (!fps.includes(h.fingerprint)) connectorMatch = false;
        digestParts.push(
          `ch:${h.id}:${h.connector_id ?? ''}:${h.fingerprint}:${sha256Hex(h.ciphertext)}:${sha256Hex(h.key_id)}`,
        );
      }
    }
  }
  for (const h of conh.rows) {
    if (!h.connector_id) {
      connectorMatch = false;
      continue;
    }
    const owner = conn.rows.find((c) => c.id === h.connector_id);
    if (!owner) {
      connectorMatch = false;
      dangling = true;
    }
  }
  domains.connectors = {
    historyCount: conh.rows.length,
    match: connectorMatch,
    referenceCount: conn.rows.filter((c) => c.shared_ref || c.oauth_ref).length,
  };
  if (!connectorMatch) match = false;

  return {
    aggregateDigest: sha256Hex(digestParts.join('\n')),
    dangling,
    domains,
    match: match && !dangling,
  };
};

/**
 * Publication pointers for every declared source domain.
 * Binds exact resource_type (or domain version owner FK) + id + revision/version + checksum.
 */
export const verifyPublicationPointers = async (
  client: PoolClient,
  options?: { priorPublishedCount?: number; priorPointerDigest?: string },
): Promise<BooleanInvariant & { pointerDigest: string }> => {
  const pointerLines: string[] = [];

  for (const source of PUBLICATION_POINTER_SOURCES) {
    const exists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [source.table],
    );
    if (!exists.rows[0]?.exists) {
      return {
        match: false,
        detail: `missing-pointer-table:${source.table}`,
        pointerDigest: sha256Hex(''),
      };
    }
    const colExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS exists`,
      [source.table, source.pointerColumn],
    );
    if (!colExists.rows[0]?.exists) {
      pointerLines.push(`${source.table}:${source.pointerColumn}:absent`);
      continue;
    }

    const rows = await client.query<Record<string, unknown>>(
      `SELECT "${source.idColumn}"::text AS id, "${source.pointerColumn}"::text AS pointer
       FROM "${source.table}"
       WHERE "${source.pointerColumn}" IS NOT NULL
       ORDER BY "${source.idColumn}"::text`,
    );
    for (const row of rows.rows) {
      const id = String(row.id ?? '');
      const pointer = String(row.pointer ?? '');

      if (source.kind === 'resource-revision') {
        if (!/^\d+$/u.test(pointer)) {
          return {
            match: false,
            detail: `non-integer-revision-pointer:${source.table}:${id}:${pointer}`,
            pointerDigest: sha256Hex(pointerLines.join('\n')),
          };
        }
        // Exact type + owner + revision + checksum; no cross-type same-number fallback.
        const resolved = await client.query<{
          checksum: string;
          resource_id: string;
          resource_type: string;
          revision: string;
        }>(
          `SELECT resource_type, resource_id, revision::text AS revision, checksum
           FROM platform_resource_revisions
           WHERE revision = $1 AND resource_id = $2 AND resource_type = $3`,
          [Number(pointer), id, source.resourceType],
        );
        const resolvedCount = resolved.rowCount ?? 0;
        if (resolvedCount === 0) {
          return {
            match: false,
            detail: `dangling-pointer:${source.table}:${id}:${pointer}:${source.resourceType}`,
            pointerDigest: sha256Hex(pointerLines.join('\n')),
          };
        }
        if (resolvedCount > 1) {
          return {
            match: false,
            detail: `ambiguous-pointer:${source.table}:${id}:${pointer}`,
            pointerDigest: sha256Hex(pointerLines.join('\n')),
          };
        }
        const target = resolved.rows[0]!;
        if (target.resource_id !== id || target.resource_type !== source.resourceType) {
          return {
            match: false,
            detail: `pointer-owner-or-type-mismatch:${source.table}:${id}`,
            pointerDigest: sha256Hex(pointerLines.join('\n')),
          };
        }
        pointerLines.push(
          `${source.table}:${id}:${pointer}:${target.resource_type}:${target.checksum}`,
        );
        continue;
      }

      // domain-version: join exact version table; target must belong to owner.
      const versionExists = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1
         ) AS exists`,
        [source.versionTable],
      );
      if (!versionExists.rows[0]?.exists) {
        return {
          match: false,
          detail: `missing-version-table:${source.versionTable}`,
          pointerDigest: sha256Hex(pointerLines.join('\n')),
        };
      }
      // Prefer content_digest when present (immutable target payload).
      const hasContent = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'content_digest'
         ) AS exists`,
        [source.versionTable],
      );
      const versionRows = hasContent.rows[0]?.exists
        ? await client.query<{ content_digest: string | null; id: string; owner_id: string }>(
            `SELECT id::text AS id, "${source.ownerColumn}"::text AS owner_id,
                    content_digest::text AS content_digest
             FROM "${source.versionTable}"
             WHERE id::text = $1`,
            [pointer],
          )
        : await client.query<{ content_digest: string | null; id: string; owner_id: string }>(
            `SELECT id::text AS id, "${source.ownerColumn}"::text AS owner_id,
                    NULL::text AS content_digest
             FROM "${source.versionTable}"
             WHERE id::text = $1`,
            [pointer],
          );
      const versionCount = versionRows.rowCount ?? 0;
      if (versionCount === 0) {
        return {
          match: false,
          detail: `dangling-version-pointer:${source.table}:${id}:${pointer}`,
          pointerDigest: sha256Hex(pointerLines.join('\n')),
        };
      }
      if (versionCount > 1) {
        return {
          match: false,
          detail: `ambiguous-version-pointer:${source.table}:${id}:${pointer}`,
          pointerDigest: sha256Hex(pointerLines.join('\n')),
        };
      }
      const version = versionRows.rows[0]!;
      if (version.owner_id !== id) {
        return {
          match: false,
          detail: `version-owner-mismatch:${source.table}:${id}:${pointer}:owner=${version.owner_id}`,
          pointerDigest: sha256Hex(pointerLines.join('\n')),
        };
      }
      const targetDigest = sha256Hex(
        `${source.versionTable}|${version.id}|${version.owner_id}|${version.content_digest ?? ''}`,
      );
      pointerLines.push(`${source.table}:${id}:${pointer}:${source.versionTable}:${targetDigest}`);
    }
  }

  const pointerDigest = sha256Hex(pointerLines.join('\n'));
  if (options?.priorPointerDigest && options.priorPointerDigest !== pointerDigest) {
    return { match: false, detail: 'pointer-digest-drift', pointerDigest };
  }

  const published = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM platform_resource_revisions WHERE status = 'published'`,
  );
  const publishedCount = Number(published.rows[0]?.count ?? 0);
  if (
    options?.priorPublishedCount !== undefined &&
    publishedCount !== options.priorPublishedCount
  ) {
    return {
      match: false,
      detail: `published-count-drift:${options.priorPublishedCount}->${publishedCount}`,
      pointerDigest,
    };
  }

  return { match: true, pointerDigest };
};

export const verifyRequiredTablesPresent = async (
  client: PoolClient,
  tables: readonly string[] = RECOVERY_ENTERPRISE_TABLES,
): Promise<BooleanInvariant> => {
  for (const table of tables) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [table],
    );
    if (!result.rows[0]?.exists) {
      return { match: false, detail: `missing-table:${table}` };
    }
  }
  return { match: true };
};

export const compareDigests = (
  before: AggregateDigestResult,
  after: AggregateDigestResult,
): boolean =>
  before.digest === after.digest && before.rowCount === after.rowCount && before.rowCount >= 0;

/** Build a source-manifest style digest package for backup attestation. */
export const buildSourceManifestCore = async (client: PoolClient) => {
  const revisions = await digestResourceRevisions(client);
  const audits = await digestAuditLogs(client);
  const secrets = await verifySecretReferenceDomains(client);
  const tables = await digestAllRequiredTables(client);
  const publications = await verifyPublicationPointers(client);
  const published = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM platform_resource_revisions WHERE status = 'published'`,
  );
  return {
    audits: { digest: audits.digest, rowCount: audits.rowCount },
    pointerDigest: publications.pointerDigest,
    publishedCount: Number(published.rows[0]?.count ?? 0),
    revisions: { digest: revisions.digest, rowCount: revisions.rowCount },
    secrets: { aggregateDigest: secrets.aggregateDigest, match: secrets.match },
    tables,
  };
};

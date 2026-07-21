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
 * Canonical per-table row digests for all required enterprise tables.
 * Uses id column when present, else full-row md5 projection of text cast.
 */
export const digestAllRequiredTables = async (
  client: PoolClient,
  tables: readonly string[] = RECOVERY_ENTERPRISE_TABLES,
): Promise<TableDigestEntry[]> => {
  const entries: TableDigestEntry[] = [];
  for (const table of tables) {
    const cols = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );
    if (cols.rows.length === 0) {
      entries.push({ digest: sha256Hex(`missing:${table}`), name: table, rowCount: -1 });
      continue;
    }
    const hasId = cols.rows.some((c) => c.column_name === 'id');
    if (hasId) {
      const result = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM "${table}" ORDER BY id::text`,
      );
      entries.push({
        digest: sha256Hex(result.rows.map((r) => r.id).join('\n')),
        name: table,
        rowCount: result.rows.length,
      });
    } else {
      const colList = cols.rows.map((c) => `"${c.column_name}"::text`).join(" || '|' || ");
      const result = await client.query<{ row_key: string }>(
        `SELECT (${colList}) AS row_key FROM "${table}" ORDER BY 1`,
      );
      entries.push({
        digest: sha256Hex(result.rows.map((r) => r.row_key).join('\n')),
        name: table,
        rowCount: result.rows.length,
      });
    }
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
      // Column not in harness minimal schema — record absence
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
      pointerLines.push(`${source.table}:${id}:${pointer}`);

      // Resolve against platform_resource_revisions when pointer is integer revision-like
      if (/^\d+$/u.test(pointer)) {
        const resolved = await client.query(
          `SELECT 1 FROM platform_resource_revisions
           WHERE revision = $1 AND (
             resource_id = $2 OR resource_type = $3
           )
           LIMIT 1`,
          [Number(pointer), id, source.table.replace(/^platform_/u, '').replace(/s$/u, '')],
        );
        if (!resolved.rowCount) {
          // Still record; fail if any published revision expected
          const anyRev = await client.query(
            `SELECT 1 FROM platform_resource_revisions WHERE revision = $1 LIMIT 1`,
            [Number(pointer)],
          );
          if (!anyRev.rowCount) {
            return {
              match: false,
              detail: `dangling-pointer:${source.table}:${id}:${pointer}`,
              pointerDigest: sha256Hex(pointerLines.join('\n')),
            };
          }
        }
      }
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

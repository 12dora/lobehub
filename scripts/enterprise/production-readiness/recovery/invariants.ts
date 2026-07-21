/**
 * Full post-restore invariants: tables digests, secrets, publications, audits.
 */
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { PUBLICATION_POINTER_SOURCES, RECOVERY_ENTERPRISE_TABLES } from '../inventory';
import { canonicalize } from '../trust/canonical';

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
  const secretRecords: Record<string, unknown>[] = [];
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
    secretRecords.push({
      domain: 'idp',
      fingerprint: provider.fingerprint,
      id: provider.id,
      ref_digest: provider.ref ? sha256Hex(provider.ref) : null,
    });
    if (provider.ref || provider.fingerprint) {
      const history = idph.rows.filter((row) => row.provider_id === provider.id);
      if (history.length < 1) identityMatch = false;
      for (const h of history) {
        if (provider.fingerprint && h.fingerprint !== provider.fingerprint) identityMatch = false;
        if (provider.ref && h.ref !== provider.ref) identityMatch = false;
        secretRecords.push({
          ciphertext_digest: sha256Hex(h.ciphertext),
          domain: 'idph',
          fingerprint: h.fingerprint,
          id: h.id,
          key_id_digest: sha256Hex(h.key_id),
          provider_id: h.provider_id,
          ref_digest: sha256Hex(h.ref),
        });
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
    secretRecords.push({
      domain: 'ai',
      fingerprint: provider.fingerprint,
      id: provider.id,
      key_id_digest: provider.key_id ? sha256Hex(provider.key_id) : null,
    });
    if (provider.fingerprint) {
      const history = aih.rows.filter((row) => row.provider_id === provider.id);
      if (history.length < 1) aiMatch = false;
      for (const h of history) {
        if (h.fingerprint !== provider.fingerprint) aiMatch = false;
        secretRecords.push({
          ciphertext_digest: sha256Hex(h.ciphertext),
          domain: 'aih',
          fingerprint: h.fingerprint,
          id: h.id,
          key_id_digest: sha256Hex(h.key_id),
          provider_id: h.provider_id,
        });
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
    secretRecords.push({
      domain: 'connector',
      id: c.id,
      oauth_fp: c.oauth_fp,
      oauth_ref_digest: c.oauth_ref ? sha256Hex(c.oauth_ref) : null,
      shared_fp: c.shared_fp,
      shared_ref_digest: c.shared_ref ? sha256Hex(c.shared_ref) : null,
    });
    const fps = [c.shared_fp, c.oauth_fp].filter(Boolean) as string[];
    if (fps.length > 0) {
      const history = conh.rows.filter((row) => row.connector_id === c.id);
      if (history.length < 1) connectorMatch = false;
      for (const h of history) {
        if (!fps.includes(h.fingerprint)) connectorMatch = false;
        secretRecords.push({
          ciphertext_digest: sha256Hex(h.ciphertext),
          connector_id: h.connector_id,
          domain: 'connector-history',
          fingerprint: h.fingerprint,
          id: h.id,
          key_id_digest: sha256Hex(h.key_id),
        });
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
    aggregateDigest: digestCanonicalRecords('secret-domains', secretRecords),
    dangling,
    domains,
    match: match && !dangling,
  };
};

/**
 * Publication pointers for every declared source domain.
 * Binds domain + holder id + resource owner id + type + revision/version + checksum
 * + canonical target digest. No delimiter concatenation.
 */
export const verifyPublicationPointers = async (
  client: PoolClient,
  options?: { priorPublishedCount?: number; priorPointerDigest?: string },
): Promise<BooleanInvariant & { pointerDigest: string }> => {
  const pointerRecords: Record<string, unknown>[] = [];

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
      pointerRecords.push({
        kind: 'absent-column',
        pointerColumn: source.pointerColumn,
        table: source.table,
      });
      continue;
    }

    if (source.kind === 'resource-revision') {
      const ownerCol = source.resourceOwnerColumn;
      const typeCol = source.holderResourceTypeColumn;
      const checksumCol = source.holderChecksumColumn;

      // Probe optional holder columns (type/checksum) against real schema.
      const hasTypeCol =
        typeCol !== null
          ? (
              await client.query<{ exists: boolean }>(
                `SELECT EXISTS (
                   SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
                 ) AS exists`,
                [source.table, typeCol],
              )
            ).rows[0]?.exists === true
          : false;
      const hasChecksumCol =
        checksumCol !== null
          ? (
              await client.query<{ exists: boolean }>(
                `SELECT EXISTS (
                   SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
                 ) AS exists`,
                [source.table, checksumCol],
              )
            ).rows[0]?.exists === true
          : false;

      // Fail closed if inventory requires a holder checksum/type column that is missing.
      if (checksumCol !== null && !hasChecksumCol) {
        return {
          match: false,
          detail: `missing-holder-checksum-column:${source.table}:${checksumCol}`,
          pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
        };
      }
      if (typeCol !== null && !hasTypeCol) {
        return {
          match: false,
          detail: `missing-holder-type-column:${source.table}:${typeCol}`,
          pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
        };
      }

      const selectParts = [
        `"${source.holderIdColumn}"::text AS holder_id`,
        `"${ownerCol}"::text AS resource_owner_id`,
        `"${source.pointerColumn}"::text AS pointer`,
      ];
      if (hasTypeCol && typeCol) {
        selectParts.push(`"${typeCol}"::text AS holder_resource_type`);
      } else {
        selectParts.push(`NULL::text AS holder_resource_type`);
      }
      if (hasChecksumCol && checksumCol) {
        selectParts.push(`"${checksumCol}"::text AS holder_checksum`);
      } else {
        selectParts.push(`NULL::text AS holder_checksum`);
      }

      const rows = await client.query<{
        holder_checksum: string | null;
        holder_id: string;
        holder_resource_type: string | null;
        pointer: string;
        resource_owner_id: string;
      }>(
        `SELECT ${selectParts.join(', ')}
         FROM "${source.table}"
         WHERE "${source.pointerColumn}" IS NOT NULL
         ORDER BY "${source.holderIdColumn}"::text`,
      );
      for (const row of rows.rows) {
        const pointer = String(row.pointer ?? '');
        if (!/^\d+$/u.test(pointer)) {
          return {
            match: false,
            detail: `non-integer-revision-pointer:${source.table}:${row.holder_id}:${pointer}`,
            pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
          };
        }
        const expectedType: string =
          hasTypeCol && row.holder_resource_type ? row.holder_resource_type : source.resourceType;
        if (
          hasTypeCol &&
          row.holder_resource_type &&
          row.holder_resource_type !== source.resourceType
        ) {
          return {
            match: false,
            detail: `holder-resource-type-mismatch:${source.table}:${row.holder_id}:${row.holder_resource_type}`,
            pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
          };
        }

        type RevRow = {
          checksum: string;
          resource_id: string;
          resource_type: string;
          revision: string;
        };
        // When holder has checksum, match composite FK including checksum.
        const resolvedQuery =
          hasChecksumCol && row.holder_checksum
            ? await client.query<RevRow>(
                `SELECT resource_type, resource_id, revision::text AS revision, checksum
                 FROM platform_resource_revisions
                 WHERE revision = $1 AND resource_id = $2 AND resource_type = $3 AND checksum = $4`,
                [Number(pointer), row.resource_owner_id, expectedType, row.holder_checksum],
              )
            : await client.query<RevRow>(
                `SELECT resource_type, resource_id, revision::text AS revision, checksum
                 FROM platform_resource_revisions
                 WHERE revision = $1 AND resource_id = $2 AND resource_type = $3`,
                [Number(pointer), row.resource_owner_id, expectedType],
              );
        const resolvedCount = resolvedQuery.rowCount ?? 0;
        if (resolvedCount === 0) {
          return {
            match: false,
            detail: `dangling-pointer:${source.table}:${row.holder_id}:${pointer}:${expectedType}:owner=${row.resource_owner_id}`,
            pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
          };
        }
        if (resolvedCount > 1) {
          return {
            match: false,
            detail: `ambiguous-pointer:${source.table}:${row.holder_id}:${pointer}`,
            pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
          };
        }
        const targetRow: RevRow = resolvedQuery.rows[0]!;
        if (
          targetRow.resource_id !== row.resource_owner_id ||
          targetRow.resource_type !== expectedType
        ) {
          return {
            match: false,
            detail: `pointer-owner-or-type-mismatch:${source.table}:${row.holder_id}`,
            pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
          };
        }
        if (hasChecksumCol && row.holder_checksum && targetRow.checksum !== row.holder_checksum) {
          return {
            match: false,
            detail: `holder-checksum-mismatch:${source.table}:${row.holder_id}`,
            pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
          };
        }
        const targetDigest = digestCanonicalRecords('resource-revision-target', [
          {
            checksum: targetRow.checksum,
            resource_id: targetRow.resource_id,
            resource_type: targetRow.resource_type,
            revision: targetRow.revision,
          },
        ]);
        pointerRecords.push({
          holder_checksum: row.holder_checksum,
          holder_id: row.holder_id,
          holder_resource_type: row.holder_resource_type ?? expectedType,
          kind: 'resource-revision',
          pointer,
          resource_owner_id: row.resource_owner_id,
          resource_type: expectedType,
          table: source.table,
          target_checksum: targetRow.checksum,
          target_digest: targetDigest,
        });
      }
      continue;
    }

    // domain-version: real schema uses checksum (not content_digest).
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
        pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
      };
    }
    const hasChecksum = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS exists`,
      [source.versionTable, source.checksumColumn],
    );
    if (!hasChecksum.rows[0]?.exists) {
      return {
        match: false,
        detail: `missing-checksum-column:${source.versionTable}:${source.checksumColumn}`,
        pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
      };
    }

    const rows = await client.query<{ holder_id: string; pointer: string }>(
      `SELECT "${source.holderIdColumn}"::text AS holder_id,
              "${source.pointerColumn}"::text AS pointer
       FROM "${source.table}"
       WHERE "${source.pointerColumn}" IS NOT NULL
       ORDER BY "${source.holderIdColumn}"::text`,
    );
    for (const row of rows.rows) {
      const pointer = String(row.pointer ?? '');
      // Select stable target projection: id, owner, checksum (+ version when present).
      const hasVersion = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'version'
         ) AS exists`,
        [source.versionTable],
      );
      const versionRows = hasVersion.rows[0]?.exists
        ? await client.query<{
            checksum: string | null;
            id: string;
            owner_id: string;
            version: string | null;
          }>(
            `SELECT id::text AS id, "${source.ownerColumn}"::text AS owner_id,
                    "${source.checksumColumn}"::text AS checksum,
                    version::text AS version
             FROM "${source.versionTable}"
             WHERE id::text = $1`,
            [pointer],
          )
        : await client.query<{
            checksum: string | null;
            id: string;
            owner_id: string;
            version: string | null;
          }>(
            `SELECT id::text AS id, "${source.ownerColumn}"::text AS owner_id,
                    "${source.checksumColumn}"::text AS checksum,
                    NULL::text AS version
             FROM "${source.versionTable}"
             WHERE id::text = $1`,
            [pointer],
          );
      const versionCount = versionRows.rowCount ?? 0;
      if (versionCount === 0) {
        return {
          match: false,
          detail: `dangling-version-pointer:${source.table}:${row.holder_id}:${pointer}`,
          pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
        };
      }
      if (versionCount > 1) {
        return {
          match: false,
          detail: `ambiguous-version-pointer:${source.table}:${row.holder_id}:${pointer}`,
          pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
        };
      }
      const version = versionRows.rows[0]!;
      if (version.owner_id !== row.holder_id) {
        return {
          match: false,
          detail: `version-owner-mismatch:${source.table}:${row.holder_id}:${pointer}:owner=${version.owner_id}`,
          pointerDigest: digestCanonicalRecords('publication-pointers', pointerRecords),
        };
      }
      // Bind complete stable row projection (checksum may be null on legacy agent rows only
      // when paired with null dependency snapshot; still include full projection).
      const targetDigest = digestCanonicalRecords('domain-version-target', [
        {
          checksum: version.checksum,
          id: version.id,
          owner_id: version.owner_id,
          version: version.version,
          version_table: source.versionTable,
        },
      ]);
      pointerRecords.push({
        holder_id: row.holder_id,
        kind: 'domain-version',
        pointer,
        resource_owner_id: version.owner_id,
        table: source.table,
        target_checksum: version.checksum,
        target_digest: targetDigest,
        target_id: version.id,
        version_table: source.versionTable,
      });
    }
  }

  const pointerDigest = digestCanonicalRecords('publication-pointers', pointerRecords);
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

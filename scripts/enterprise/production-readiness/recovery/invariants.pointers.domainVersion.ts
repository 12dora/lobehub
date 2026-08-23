import type { PoolClient } from 'pg';

import { digestCanonicalRecords } from './invariants.digest';
import { checkVersionOwner, checkVersionPointerResolvedCount } from './invariants.pointers.checks';
import type { DomainVersionPointerSource, PointerCheckResult } from './invariants.pointers.result';
import { collectPointerChecks } from './invariants.pointers.result';

const checkVersionTablePresent = async (
  client: PoolClient,
  versionTable: string,
): Promise<PointerCheckResult> => {
  const versionExists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
    [versionTable],
  );
  if (!versionExists.rows[0]?.exists) {
    return {
      detail: `missing-version-table:${versionTable}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

const checkVersionChecksumColumnPresent = async (
  client: PoolClient,
  source: DomainVersionPointerSource,
): Promise<PointerCheckResult> => {
  const hasChecksum = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS exists`,
    [source.versionTable, source.checksumColumn],
  );
  if (!hasChecksum.rows[0]?.exists) {
    return {
      detail: `missing-checksum-column:${source.versionTable}:${source.checksumColumn}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

const loadDomainVersionHolders = async (client: PoolClient, source: DomainVersionPointerSource) =>
  client.query<{ holder_id: string; pointer: string }>(
    `SELECT "${source.holderIdColumn}"::text AS holder_id,
              "${source.pointerColumn}"::text AS pointer
       FROM "${source.table}"
       WHERE "${source.pointerColumn}" IS NOT NULL
       ORDER BY "${source.holderIdColumn}"::text`,
  );

const loadDomainVersionsById = async (
  client: PoolClient,
  source: DomainVersionPointerSource,
  pointers: string[],
) => {
  type VersionRow = {
    checksum: string | null;
    id: string;
    owner_id: string;
    version: string | null;
  };

  // Schema metadata once per source (not N+1).
  const hasVersion = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'version'
       ) AS exists`,
    [source.versionTable],
  );
  const includeVersion = hasVersion.rows[0]?.exists === true;

  const versionsById = new Map<string, VersionRow[]>();
  if (pointers.length > 0) {
    const versionQuery = includeVersion
      ? `SELECT id::text AS id, "${source.ownerColumn}"::text AS owner_id,
                  "${source.checksumColumn}"::text AS checksum,
                  version::text AS version
           FROM "${source.versionTable}"
           WHERE id::text = ANY($1::text[])`
      : `SELECT id::text AS id, "${source.ownerColumn}"::text AS owner_id,
                  "${source.checksumColumn}"::text AS checksum,
                  NULL::text AS version
           FROM "${source.versionTable}"
           WHERE id::text = ANY($1::text[])`;
    const versionRows = await client.query<VersionRow>(versionQuery, [pointers]);
    for (const version of versionRows.rows) {
      const list = versionsById.get(version.id) ?? [];
      list.push(version);
      versionsById.set(version.id, list);
    }
  }
  return versionsById;
};

const verifyDomainVersionPointerRow = async (
  source: DomainVersionPointerSource,
  row: { holder_id: string; pointer: string },
  versionsById: Map<
    string,
    Array<{ checksum: string | null; id: string; owner_id: string; version: string | null }>
  >,
): Promise<PointerCheckResult> => {
  const pointer = String(row.pointer ?? '');
  const matched = versionsById.get(pointer) ?? [];
  const versionCount = matched.length;
  const resolved = await collectPointerChecks([
    () => checkVersionPointerResolvedCount(source.table, row.holder_id, pointer, versionCount),
  ]);
  if (!resolved.match) return resolved;

  const version = matched[0]!;
  const owner = await collectPointerChecks([
    () => checkVersionOwner(source.table, row.holder_id, pointer, version.owner_id),
  ]);
  if (!owner.match) return owner;

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
  return {
    match: true,
    records: [
      {
        holder_id: row.holder_id,
        kind: 'domain-version',
        pointer,
        resource_owner_id: version.owner_id,
        table: source.table,
        target_checksum: version.checksum,
        target_digest: targetDigest,
        target_id: version.id,
        version_table: source.versionTable,
      },
    ],
  };
};

export const scanDomainVersionPointers = async (
  client: PoolClient,
  source: DomainVersionPointerSource,
): Promise<PointerCheckResult> => {
  // domain-version: real schema uses checksum (not content_digest).
  const schema = await collectPointerChecks([
    () => checkVersionTablePresent(client, source.versionTable),
    () => checkVersionChecksumColumnPresent(client, source),
  ]);
  if (!schema.match) return schema;

  const rows = await loadDomainVersionHolders(client, source);

  // Batch load all referenced version rows (single query; no per-row N+1).
  const pointers = rows.rows.map((row) => String(row.pointer ?? '')).filter(Boolean);
  const versionsById = await loadDomainVersionsById(client, source, pointers);

  const records: Record<string, unknown>[] = [];
  for (const row of rows.rows) {
    const one = await verifyDomainVersionPointerRow(source, row, versionsById);
    if (!one.match) return { ...one, records: [...records, ...one.records] };
    records.push(...one.records);
  }
  return { match: true, records };
};

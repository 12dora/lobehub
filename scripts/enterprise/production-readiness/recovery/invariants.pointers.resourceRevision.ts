import type { PoolClient } from 'pg';

import { digestCanonicalRecords } from './invariants.digest';
import {
  checkHolderChecksumFormat,
  checkHolderChecksumMatchesTarget,
  checkHolderResourceType,
  checkPointerOwnerOrType,
  checkResourceRevisionResolvedCount,
  checkRevisionPointerInteger,
  checkTargetRevisionStatus,
} from './invariants.pointers.checks';
import type {
  PointerCheckFail,
  PointerCheckResult,
  ResourceRevisionPointerSource,
  ResourceRevisionTargetRow,
} from './invariants.pointers.result';
import { collectPointerChecks } from './invariants.pointers.result';

interface ResourceRevisionHolderSchema {
  checksumCol: string | null;
  hasChecksumCol: boolean;
  hasTypeCol: boolean;
  ownerCol: string;
  typeCol: string | null;
}

type ResourceRevisionHolderColumnResult =
  | PointerCheckFail
  | { match: true; records: Record<string, unknown>[]; schema: ResourceRevisionHolderSchema };

const checkResourceRevisionHolderColumns = async (
  client: PoolClient,
  source: ResourceRevisionPointerSource,
): Promise<ResourceRevisionHolderColumnResult> => {
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
      detail: `missing-holder-checksum-column:${source.table}:${checksumCol}`,
      match: false,
      records: [],
    };
  }
  if (typeCol !== null && !hasTypeCol) {
    return {
      detail: `missing-holder-type-column:${source.table}:${typeCol}`,
      match: false,
      records: [],
    };
  }

  return {
    match: true,
    records: [],
    schema: { checksumCol, hasChecksumCol, hasTypeCol, ownerCol, typeCol },
  };
};

const loadResourceRevisionHolders = async (
  client: PoolClient,
  source: ResourceRevisionPointerSource,
  schema: ResourceRevisionHolderSchema,
) => {
  const { checksumCol, hasChecksumCol, hasTypeCol, ownerCol, typeCol } = schema;
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

  return client.query<{
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
};

const resolveResourceRevisionTarget = async (
  client: PoolClient,
  checksumCol: string | null,
  pointer: string,
  row: { holder_checksum: string | null; resource_owner_id: string },
  expectedType: string,
) =>
  // Resolve by identity first, then enforce published status (explicit reason).
  checksumCol !== null
    ? client.query<ResourceRevisionTargetRow>(
        `SELECT resource_type, resource_id, revision::text AS revision, checksum, status
                 FROM platform_resource_revisions
                 WHERE revision = $1 AND resource_id = $2 AND resource_type = $3 AND checksum = $4`,
        [Number(pointer), row.resource_owner_id, expectedType, row.holder_checksum],
      )
    : client.query<ResourceRevisionTargetRow>(
        `SELECT resource_type, resource_id, revision::text AS revision, checksum, status
                 FROM platform_resource_revisions
                 WHERE revision = $1 AND resource_id = $2 AND resource_type = $3`,
        [Number(pointer), row.resource_owner_id, expectedType],
      );

const toResourceRevisionPointerRecord = (
  source: ResourceRevisionPointerSource,
  row: {
    holder_checksum: string | null;
    holder_id: string;
    holder_resource_type: string | null;
    resource_owner_id: string;
  },
  pointer: string,
  expectedType: string,
  targetRow: ResourceRevisionTargetRow,
): Record<string, unknown> => {
  const targetDigest = digestCanonicalRecords('resource-revision-target', [
    {
      checksum: targetRow.checksum,
      resource_id: targetRow.resource_id,
      resource_type: targetRow.resource_type,
      revision: targetRow.revision,
      status: targetRow.status,
    },
  ]);
  return {
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
    target_status: targetRow.status,
  };
};

const verifyResourceRevisionHolderRow = async (
  client: PoolClient,
  source: ResourceRevisionPointerSource,
  schema: ResourceRevisionHolderSchema,
  row: {
    holder_checksum: string | null;
    holder_id: string;
    holder_resource_type: string | null;
    pointer: string;
    resource_owner_id: string;
  },
): Promise<PointerCheckResult> => {
  const { checksumCol, hasTypeCol } = schema;
  const pointer = String(row.pointer ?? '');
  const shape = await collectPointerChecks([
    () => checkRevisionPointerInteger(source.table, row.holder_id, pointer),
    () =>
      checkHolderResourceType(
        source.table,
        row.holder_id,
        hasTypeCol,
        row.holder_resource_type,
        source.resourceType,
      ),
    // Inventory-declared holderChecksumColumn is mandatory: never weak-fallback.
    () => checkHolderChecksumFormat(source.table, row.holder_id, checksumCol, row.holder_checksum),
  ]);
  if (!shape.match) return shape;

  const expectedType: string =
    hasTypeCol && row.holder_resource_type ? row.holder_resource_type : source.resourceType;

  const resolvedQuery = await resolveResourceRevisionTarget(
    client,
    checksumCol,
    pointer,
    row,
    expectedType,
  );
  const resolvedCount = resolvedQuery.rowCount ?? 0;
  const resolved = await collectPointerChecks([
    () =>
      checkResourceRevisionResolvedCount(
        source.table,
        row.holder_id,
        pointer,
        expectedType,
        row.resource_owner_id,
        resolvedCount,
      ),
  ]);
  if (!resolved.match) return resolved;

  const targetRow: ResourceRevisionTargetRow = resolvedQuery.rows[0]!;
  const target = await collectPointerChecks([
    () =>
      checkPointerOwnerOrType(
        source.table,
        row.holder_id,
        targetRow,
        row.resource_owner_id,
        expectedType,
      ),
    () =>
      checkHolderChecksumMatchesTarget(
        source.table,
        row.holder_id,
        checksumCol,
        targetRow.checksum,
        row.holder_checksum,
      ),
    () => checkTargetRevisionStatus(source.table, row.holder_id, pointer, targetRow.status),
  ]);
  if (!target.match) return target;

  return {
    match: true,
    records: [toResourceRevisionPointerRecord(source, row, pointer, expectedType, targetRow)],
  };
};

export const scanResourceRevisionPointers = async (
  client: PoolClient,
  source: ResourceRevisionPointerSource,
): Promise<PointerCheckResult> => {
  const schemaResult = await checkResourceRevisionHolderColumns(client, source);
  if (!schemaResult.match) return schemaResult;
  const { schema } = schemaResult;

  const rows = await loadResourceRevisionHolders(client, source, schema);
  const records: Record<string, unknown>[] = [];
  for (const row of rows.rows) {
    const one = await verifyResourceRevisionHolderRow(client, source, schema, row);
    if (!one.match) return { ...one, records: [...records, ...one.records] };
    records.push(...one.records);
  }
  return { match: true, records };
};

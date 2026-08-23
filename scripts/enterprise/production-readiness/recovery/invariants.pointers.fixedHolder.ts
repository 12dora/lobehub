import type { PoolClient } from 'pg';

import { digestCanonicalRecords } from './invariants.digest';
import {
  checkExtraPublishedHolders,
  checkFixedHolderPresence,
  checkFixedHolderPublishedShape,
  checkFixedPointerResolvedCount,
  checkFixedPointerTarget,
  checkFixedTargetRevisionStatus,
  checkRevisionHistoryStatuses,
} from './invariants.pointers.checks';
import type {
  FixedHolderRevisionPointerSource,
  PointerCheckResult,
  ResourceRevisionTargetRow,
} from './invariants.pointers.result';
import { collectPointerChecks } from './invariants.pointers.result';

const checkHolderStatusColumnPresent = async (
  client: PoolClient,
  source: FixedHolderRevisionPointerSource,
): Promise<PointerCheckResult> => {
  const statusCol = source.holderStatusColumn;
  const hasStatus = (
    await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
           ) AS exists`,
      [source.table, statusCol],
    )
  ).rows[0]?.exists;
  if (!hasStatus) {
    return {
      detail: `missing-holder-status-column:${source.table}:${statusCol}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

const loadFixedHolderSnapshot = async (
  client: PoolClient,
  source: FixedHolderRevisionPointerSource,
) => {
  const statusCol = source.holderStatusColumn;

  // Fixed holder by exact id — do not filter on status/revision here.
  const holders = await client.query<{
    holder_id: string;
    pointer: string;
    status: string;
  }>(
    `SELECT "${source.holderIdColumn}"::text AS holder_id,
                "${source.pointerColumn}"::text AS pointer,
                "${statusCol}"::text AS status
         FROM "${source.table}"
         WHERE "${source.holderIdColumn}"::text = $1`,
    [source.holderIdValue],
  );

  // Legacy / extra published holder rows on the same table (wrong id).
  const extraPublished = await client.query<{ holder_id: string }>(
    `SELECT "${source.holderIdColumn}"::text AS holder_id
         FROM "${source.table}"
         WHERE "${statusCol}"::text = $1
           AND "${source.holderIdColumn}"::text <> $2
         ORDER BY 1`,
    [source.holderStatusValue, source.holderIdValue],
  );

  // Any revision history for the constant owner (status-independent).
  const historyRows = await client.query<{
    revision: string;
    status: string | null;
  }>(
    `SELECT revision::text AS revision, status
         FROM platform_resource_revisions
         WHERE resource_type = $1 AND resource_id = $2
         ORDER BY revision`,
    [source.resourceType, source.resourceOwnerConstant],
  );

  return { extraPublished, historyRows, holders };
};

const resolveFixedHolderTarget = async (
  client: PoolClient,
  source: FixedHolderRevisionPointerSource,
  holder: { pointer: string },
) => {
  type RevRow = ResourceRevisionTargetRow;
  return client.query<RevRow>(
    `SELECT resource_type, resource_id, revision::text AS revision, checksum, status
         FROM platform_resource_revisions
         WHERE revision = $1 AND resource_id = $2 AND resource_type = $3`,
    [Number(holder.pointer), source.resourceOwnerConstant, source.resourceType],
  );
};

const verifyPublishedFixedHolder = async (
  client: PoolClient,
  source: FixedHolderRevisionPointerSource,
  holder: { holder_id: string; pointer: string; status: string },
  historyRows: ReadonlyArray<{ revision: string; status: string | null }>,
): Promise<PointerCheckResult> => {
  const shape = await collectPointerChecks([
    () => checkFixedHolderPublishedShape(source.table, holder, source.holderStatusValue),
  ]);
  if (!shape.match) return shape;

  const resolvedQuery = await resolveFixedHolderTarget(client, source, holder);
  const resolvedCount = resolvedQuery.rowCount ?? 0;
  const resolved = await collectPointerChecks([
    () =>
      checkFixedPointerResolvedCount(source.table, holder.holder_id, holder.pointer, resolvedCount),
  ]);
  if (!resolved.match) return resolved;

  const targetRow = resolvedQuery.rows[0]!;
  const target = await collectPointerChecks([
    () =>
      checkFixedPointerTarget(
        source.table,
        holder.holder_id,
        targetRow,
        source.resourceOwnerConstant,
        source.resourceType,
      ),
    () =>
      checkFixedTargetRevisionStatus(
        source.table,
        holder.holder_id,
        holder.pointer,
        targetRow.status,
      ),
    () =>
      checkRevisionHistoryStatuses(
        source.table,
        source.resourceType,
        source.resourceOwnerConstant,
        historyRows,
      ),
  ]);
  if (!target.match) return target;

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
    match: true,
    records: [
      {
        holder_id: holder.holder_id,
        holder_status: holder.status,
        kind: 'fixed-holder-revision',
        pointer: holder.pointer,
        publication: 'published',
        resource_owner_id: source.resourceOwnerConstant,
        resource_type: source.resourceType,
        table: source.table,
        target_checksum: targetRow.checksum,
        target_digest: targetDigest,
        target_status: targetRow.status,
      },
    ],
  };
};

export const scanFixedHolderRevisionPointers = async (
  client: PoolClient,
  source: FixedHolderRevisionPointerSource,
): Promise<PointerCheckResult> => {
  // platform_branding fixed row branding:published → branding/global.
  // History = any immutable platform_resource_revisions row for (type, owner),
  // independent of current status. Genuine pre-publish requires zero history
  // and no fixed/extra published holders. Target of a published holder must
  // itself have status = RESOURCE_REVISION_PUBLISHED_STATUS.
  const statusColumn = await checkHolderStatusColumnPresent(client, source);
  if (!statusColumn.match) return statusColumn;

  const { extraPublished, historyRows, holders } = await loadFixedHolderSnapshot(client, source);
  const snapshot = await collectPointerChecks([
    () =>
      checkExtraPublishedHolders(
        source.table,
        extraPublished.rows.map((r) => r.holder_id),
      ),
    () =>
      checkFixedHolderPresence(
        source,
        holders.rows.length,
        (historyRows.rowCount ?? 0) > 0,
        historyRows.rowCount,
      ),
  ]);
  if (!snapshot.match) return snapshot;
  if (snapshot.skipSource) return snapshot;

  const holder = holders.rows[0]!;
  // Fixed row present: must be exactly published with positive revision.
  return verifyPublishedFixedHolder(client, source, holder, historyRows.rows);
};

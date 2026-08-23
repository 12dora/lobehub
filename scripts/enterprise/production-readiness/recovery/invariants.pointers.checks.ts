import type { PoolClient } from 'pg';

import type {
  FixedHolderRevisionPointerSource,
  PointerCheckResult,
  ResourceRevisionTargetRow,
} from './invariants.pointers.result';
import { RESOURCE_REVISION_PUBLISHED_STATUS } from './invariants.pointers.result';

export const checkPointerTablePresent = async (
  client: PoolClient,
  table: string,
): Promise<PointerCheckResult> => {
  const exists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
    [table],
  );
  if (!exists.rows[0]?.exists) {
    return {
      detail: `missing-pointer-table:${table}`,
      emptyDigest: true,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkPointerColumnPresent = async (
  client: PoolClient,
  table: string,
  pointerColumn: string,
): Promise<PointerCheckResult> => {
  const colExists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS exists`,
    [table, pointerColumn],
  );
  if (!colExists.rows[0]?.exists) {
    return {
      match: true,
      records: [
        {
          kind: 'absent-column',
          pointerColumn,
          table,
        },
      ],
      skipSource: true,
    };
  }
  return { match: true, records: [] };
};

export const checkRevisionPointerInteger = (
  table: string,
  holderId: string,
  pointer: string,
): PointerCheckResult => {
  if (!/^\d+$/u.test(pointer)) {
    return {
      detail: `non-integer-revision-pointer:${table}:${holderId}:${pointer}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkHolderResourceType = (
  table: string,
  holderId: string,
  hasTypeCol: boolean,
  holderResourceType: string | null,
  inventoryResourceType: string,
): PointerCheckResult => {
  if (hasTypeCol && holderResourceType && holderResourceType !== inventoryResourceType) {
    return {
      detail: `holder-resource-type-mismatch:${table}:${holderId}:${holderResourceType}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkHolderChecksumFormat = (
  table: string,
  holderId: string,
  checksumCol: string | null,
  holderChecksum: string | null,
): PointerCheckResult => {
  if (
    checksumCol !== null &&
    (holderChecksum === null || holderChecksum === '' || !/^[a-f\d]{64}$/u.test(holderChecksum))
  ) {
    return {
      detail: `missing-or-invalid-holder-checksum:${table}:${holderId}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkResourceRevisionResolvedCount = (
  table: string,
  holderId: string,
  pointer: string,
  expectedType: string,
  resourceOwnerId: string,
  resolvedCount: number,
): PointerCheckResult => {
  if (resolvedCount === 0) {
    return {
      detail: `dangling-pointer:${table}:${holderId}:${pointer}:${expectedType}:owner=${resourceOwnerId}`,
      match: false,
      records: [],
    };
  }
  if (resolvedCount > 1) {
    return {
      detail: `ambiguous-pointer:${table}:${holderId}:${pointer}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkPointerOwnerOrType = (
  table: string,
  holderId: string,
  targetRow: ResourceRevisionTargetRow,
  resourceOwnerId: string,
  expectedType: string,
): PointerCheckResult => {
  if (targetRow.resource_id !== resourceOwnerId || targetRow.resource_type !== expectedType) {
    return {
      detail: `pointer-owner-or-type-mismatch:${table}:${holderId}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkHolderChecksumMatchesTarget = (
  table: string,
  holderId: string,
  checksumCol: string | null,
  targetChecksum: string,
  holderChecksum: string | null,
): PointerCheckResult => {
  if (checksumCol !== null && targetChecksum !== holderChecksum) {
    return {
      detail: `holder-checksum-mismatch:${table}:${holderId}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkTargetRevisionStatus = (
  table: string,
  holderId: string,
  pointer: string,
  status: string,
): PointerCheckResult => {
  if (status !== RESOURCE_REVISION_PUBLISHED_STATUS) {
    return {
      detail: `target-revision-status-mismatch:${table}:${holderId}:${pointer}:status=${status}:expected=${RESOURCE_REVISION_PUBLISHED_STATUS}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkExtraPublishedHolders = (
  table: string,
  extraHolderIds: readonly string[],
): PointerCheckResult => {
  if (extraHolderIds.length > 0) {
    return {
      detail: `extra-published-holder:${table}:${extraHolderIds.join(',')}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkFixedHolderPresence = (
  source: FixedHolderRevisionPointerSource,
  holderCount: number,
  hasRevisionHistory: boolean,
  historyRowCount: number | null,
): PointerCheckResult => {
  if (holderCount === 0) {
    if (hasRevisionHistory) {
      return {
        detail: `missing-fixed-holder-with-revision-history:${source.table}:${source.holderIdValue}:${source.resourceType}/${source.resourceOwnerConstant}:history=${historyRowCount}`,
        match: false,
        records: [],
      };
    }
    // Genuine pre-publish: no fixed row, no extra published holders, zero history.
    return {
      match: true,
      records: [
        {
          holder_id: source.holderIdValue,
          kind: 'fixed-holder-revision',
          publication: 'none',
          resource_owner_id: source.resourceOwnerConstant,
          resource_type: source.resourceType,
          state: 'pre-publish',
          table: source.table,
        },
      ],
      skipSource: true,
    };
  }

  if (holderCount !== 1) {
    return {
      detail: `ambiguous-fixed-holder-id:${source.table}:${source.holderIdValue}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkFixedHolderPublishedShape = (
  table: string,
  holder: { holder_id: string; pointer: string; status: string },
  holderStatusValue: string,
): PointerCheckResult => {
  if (holder.status !== holderStatusValue) {
    return {
      detail: `fixed-holder-status-mismatch:${table}:${holder.holder_id}:${holder.status}`,
      match: false,
      records: [],
    };
  }
  if (!/^\d+$/u.test(holder.pointer) || Number(holder.pointer) <= 0) {
    return {
      detail: `invalid-fixed-holder-revision:${table}:${holder.holder_id}:${holder.pointer}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkFixedPointerResolvedCount = (
  table: string,
  holderId: string,
  pointer: string,
  resolvedCount: number,
): PointerCheckResult => {
  if (resolvedCount === 0) {
    return {
      detail: `dangling-fixed-pointer:${table}:${holderId}:${pointer}`,
      match: false,
      records: [],
    };
  }
  if (resolvedCount > 1) {
    return {
      detail: `ambiguous-fixed-pointer:${table}:${holderId}:${pointer}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkFixedPointerTarget = (
  table: string,
  holderId: string,
  targetRow: ResourceRevisionTargetRow,
  resourceOwnerConstant: string,
  resourceType: string,
): PointerCheckResult => {
  if (targetRow.resource_id !== resourceOwnerConstant || targetRow.resource_type !== resourceType) {
    return {
      detail: `fixed-pointer-target-mismatch:${table}:${holderId}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkFixedTargetRevisionStatus = (
  table: string,
  holderId: string,
  pointer: string,
  status: string,
): PointerCheckResult => {
  if (status !== RESOURCE_REVISION_PUBLISHED_STATUS) {
    return {
      detail: `fixed-target-revision-status-mismatch:${table}:${holderId}:${pointer}:status=${status}:expected=${RESOURCE_REVISION_PUBLISHED_STATUS}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkRevisionHistoryStatuses = (
  table: string,
  resourceType: string,
  resourceOwner: string,
  historyRows: ReadonlyArray<{ revision: string; status: string | null }>,
): PointerCheckResult => {
  for (const hist of historyRows) {
    if (hist.status === null || hist.status === '') {
      return {
        detail: `revision-history-status-invalid:${table}:${resourceType}/${resourceOwner}:rev=${hist.revision}`,
        match: false,
        records: [],
      };
    }
  }
  return { match: true, records: [] };
};

export const checkVersionPointerResolvedCount = (
  table: string,
  holderId: string,
  pointer: string,
  versionCount: number,
): PointerCheckResult => {
  if (versionCount === 0) {
    return {
      detail: `dangling-version-pointer:${table}:${holderId}:${pointer}`,
      match: false,
      records: [],
    };
  }
  if (versionCount > 1) {
    return {
      detail: `ambiguous-version-pointer:${table}:${holderId}:${pointer}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkVersionOwner = (
  table: string,
  holderId: string,
  pointer: string,
  versionOwnerId: string,
): PointerCheckResult => {
  if (versionOwnerId !== holderId) {
    return {
      detail: `version-owner-mismatch:${table}:${holderId}:${pointer}:owner=${versionOwnerId}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

export const checkPointerDigestDrift = (
  pointerDigest: string,
  priorPointerDigest: string | undefined,
): PointerCheckResult => {
  if (priorPointerDigest && priorPointerDigest !== pointerDigest) {
    return { detail: 'pointer-digest-drift', match: false, records: [] };
  }
  return { match: true, records: [] };
};

export const checkPublishedCountDrift = async (
  client: PoolClient,
  priorPublishedCount: number | undefined,
): Promise<PointerCheckResult> => {
  const published = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM platform_resource_revisions WHERE status = 'published'`,
  );
  const publishedCount = Number(published.rows[0]?.count ?? 0);
  if (priorPublishedCount !== undefined && publishedCount !== priorPublishedCount) {
    return {
      detail: `published-count-drift:${priorPublishedCount}->${publishedCount}`,
      match: false,
      records: [],
    };
  }
  return { match: true, records: [] };
};

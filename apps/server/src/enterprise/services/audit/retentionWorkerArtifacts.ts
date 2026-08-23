/**
 * Export-artifact purge processor for audit retention (SAO-009).
 */

import {
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportKind,
  type PlatformAuditLegalHoldModel,
  type PlatformAuditRetentionCounts,
  PlatformAuditRetentionRunModel,
} from '@/database/models/platform';

import { type AuditExportArtifactStorage, buildAuditExportStorageKey } from './exportStorage';
import { AUDIT_RETENTION_BATCH_LIMIT } from './retentionConstants';
import {
  deleteExportArtifactObject,
  exportArtifactObjectExists,
} from './retentionWorkerArtifactIo';
import {
  collectExportFilterHoldScopes,
  exportArtifactHeld,
  loadHoldIndexForScopes,
} from './retentionWorkerHolds';
import { keysetAfterPage, mergeCounts, type ScopeProcessorParams } from './retentionWorkerShared';

export type ArtifactPurgeSeams = {
  afterArtifactAuthorize?: (info: {
    authorized: Array<{ id: string; storageKey: string }>;
  }) => Promise<void> | void;
  afterArtifactClaim?: (info: {
    claimed: Array<{ id: string; storageKey: string }>;
  }) => Promise<void> | void;
};

export const resolveExportArtifactHeldIds = async (
  tx: ConstructorParameters<typeof PlatformAuditLegalHoldModel>[0],
  rows: Array<{
    filterSnapshot: PlatformAuditExportFilterSnapshot | null | undefined;
    id: string;
    kind: PlatformAuditExportKind;
  }>,
): Promise<Set<string>> => {
  const scopeRefs = collectExportFilterHoldScopes(rows);
  const index = await loadHoldIndexForScopes(tx, scopeRefs);
  const held = new Set<string>();
  for (const row of rows) {
    if (exportArtifactHeld(index, row.kind, row.filterSnapshot)) {
      held.add(row.id);
    }
  }
  return held;
};

/**
 * Optional authorize seam (for race tests) then lock-held purge:
 * hold recheck + external object delete + complete outbox under one advisory lock.
 * Hold creates serialize behind that TX — no authorize→delete race window.
 */
export const deleteAuthorizedExportArtifacts = async (params: {
  afterArtifactAuthorize?: ArtifactPurgeSeams['afterArtifactAuthorize'];
  ids: string[];
  repo: ScopeProcessorParams['repo'];
  /** When set, attribute each successful delete / hold-skip onto the run in the same TX (F7). */
  runId?: string;
  storage: AuditExportArtifactStorage;
}): Promise<{ deleted: number; skippedHold: number }> => {
  if (params.ids.length === 0) return { deleted: 0, skippedHold: 0 };

  // Preliminary authorize for the test seam only (does not destroy).
  if (params.afterArtifactAuthorize) {
    const authorized = await params.repo.authorizeExportArtifactObjectDeletes({
      ids: params.ids,
      resolveHeldIds: resolveExportArtifactHeldIds,
    });
    if (authorized.length > 0) {
      await params.afterArtifactAuthorize({ authorized: [...authorized] });
    }
  }

  try {
    return await params.repo.purgeExportArtifactObjectsUnderHoldLock({
      deleteObject: (storageKey) => deleteExportArtifactObject(params.storage, storageKey),
      ids: params.ids,
      // HEAD reconciliation for crash-after-delete (DB-001).
      objectExists: (storageKey) => exportArtifactObjectExists(params.storage, storageKey),
      // Attribute accounting with outbox complete so a slow delete that outlives
      // the job lease still records exportArtifactsDeleted (F7).
      onObjectDeleted: params.runId
        ? async (tx, _id) => {
            await new PlatformAuditRetentionRunModel(tx).incrementCounts(params.runId!, {
              exportArtifactsDeleted: 1,
            });
          }
        : undefined,
      onObjectDeferredHold: params.runId
        ? async (tx, _id) => {
            await new PlatformAuditRetentionRunModel(tx).incrementCounts(params.runId!, {
              skippedLegalHold: 1,
            });
          }
        : undefined,
      resolveHeldIds: resolveExportArtifactHeldIds,
    });
  } catch {
    // Leave purge outbox pending for retry — never complete without delete.
    throw new Error('AUDIT_RETENTION_ARTIFACT_DELETE_FAILED');
  }
};

type ArtifactScopeProcessorParams = ScopeProcessorParams & {
  afterArtifactAuthorize?: ArtifactPurgeSeams['afterArtifactAuthorize'];
  afterArtifactClaim?: ArtifactPurgeSeams['afterArtifactClaim'];
  storage?: AuditExportArtifactStorage;
};

type ExportArtifactCandidate = {
  filterSnapshot: PlatformAuditExportFilterSnapshot | null | undefined;
  id: string;
  kind: PlatformAuditExportKind;
};

const drainStrandedArtifactPurges = async (params: ArtifactScopeProcessorParams): Promise<void> => {
  if (!params.storage) {
    throw new Error('AUDIT_RETENTION_ARTIFACT_STORAGE_REQUIRED');
  }
  // F6: claimNext may dead-letter a final-attempt export without worker cleanup.
  // Promote running+dead-job rows into failed + purge outbox before draining.
  await params.repo.reconcileDeadLetterExportArtifacts({
    buildStorageKey: buildAuditExportStorageKey,
    limit: AUDIT_RETENTION_BATCH_LIMIT,
  });
  for (;;) {
    await params.renewLease();
    const pending = await params.repo.listPendingExportArtifactPurges({
      limit: AUDIT_RETENTION_BATCH_LIMIT,
    });
    if (pending.length === 0) break;

    let drainedDeleted = 0;
    let drainedSkippedHold = 0;
    const grouped = new Map<string | null, string[]>();
    for (const item of pending) {
      const ids = grouped.get(item.purgeRunId) ?? [];
      ids.push(item.id);
      grouped.set(item.purgeRunId, ids);
    }
    for (const [purgeRunId, ids] of grouped) {
      const drained = await deleteAuthorizedExportArtifacts({
        afterArtifactAuthorize: params.afterArtifactAuthorize,
        ids,
        repo: params.repo,
        runId: purgeRunId ?? undefined,
        storage: params.storage,
      });
      drainedDeleted += drained.deleted;
      drainedSkippedHold += drained.skippedHold;
    }
    if (drainedDeleted === 0 && drainedSkippedHold === pending.length) break;
    if (pending.length < AUDIT_RETENTION_BATCH_LIMIT) break;
  }
};

const countPostClaimHoldSkips = async (args: {
  claimedIds: string[];
  db: ScopeProcessorParams['db'];
  delta: PlatformAuditRetentionCounts;
  freeIds: string[];
  items: ExportArtifactCandidate[];
  scopeRefs: ReturnType<typeof collectExportFilterHoldScopes>;
}): Promise<void> => {
  const claimedSet = new Set(args.claimedIds);
  const holdsNow = await loadHoldIndexForScopes(args.db, args.scopeRefs);
  for (const id of args.freeIds) {
    if (claimedSet.has(id)) continue;
    const art = args.items.find((r) => r.id === id);
    if (art && exportArtifactHeld(holdsNow, art.kind, art.filterSnapshot)) {
      args.delta.skippedLegalHold = (args.delta.skippedLegalHold ?? 0) + 1;
    }
  }
};

const claimFreeExportArtifacts = async (
  params: ArtifactScopeProcessorParams,
  args: {
    delta: PlatformAuditRetentionCounts;
    freeIds: string[];
    items: ExportArtifactCandidate[];
    scopeRefs: ReturnType<typeof collectExportFilterHoldScopes>;
  },
): Promise<string[]> => {
  // Phase 1: under lock, recheck holds + durable tombstone claim (outbox).
  // Outbox is the pre-destruction journal; never delete objects before the
  // durable run/job checkpoint for this page.
  const claimed = await params.repo.claimExportArtifactsRechecked({
    cutoffAt: params.cutoffAt,
    ids: args.freeIds,
    resolveHeldIds: resolveExportArtifactHeldIds,
    runId: params.runId,
  });
  const claimedIds = claimed.map((c) => c.id);

  if (claimed.length < args.freeIds.length) {
    // Pre-filter free → claim skipped: count only those still held (not
    // concurrent eligibility races).
    await countPostClaimHoldSkips({
      claimedIds,
      db: params.db,
      delta: args.delta,
      freeIds: args.freeIds,
      items: args.items,
      scopeRefs: args.scopeRefs,
    });
  }

  if (params.afterArtifactClaim) {
    await params.afterArtifactClaim({
      claimed: claimed.map((c) => ({ id: c.id, storageKey: c.storageKey })),
    });
  }

  return claimedIds;
};

const purgeClaimedExportArtifacts = async (
  params: ArtifactScopeProcessorParams,
  claimedIds: string[],
  counts: PlatformAuditRetentionCounts,
): Promise<PlatformAuditRetentionCounts> => {
  if (!params.storage) {
    throw new Error('AUDIT_RETENTION_ARTIFACT_STORAGE_REQUIRED');
  }

  let nextCounts = counts;
  // Phase 2–3: one object at a time with lease renew. Counts for deleted /
  // deferred-hold are written inside the purge TX via runId (not a second
  // job checkpoint that can fail after the object is already gone).
  for (const id of claimedIds) {
    await params.renewLease();
    const result = await deleteAuthorizedExportArtifacts({
      afterArtifactAuthorize: params.afterArtifactAuthorize,
      ids: [id],
      repo: params.repo,
      runId: params.runId,
      storage: params.storage,
    });

    // Mirror in-memory counts for subsequent local merges / complete().
    // Domain attribution already committed with outbox complete (F7).
    if (result.deleted > 0 || result.skippedHold > 0) {
      nextCounts = mergeCounts(nextCounts, {
        exportArtifactsDeleted: result.deleted,
        skippedLegalHold: result.skippedHold,
      });
    }
    // Heartbeat after each object; LeaseLost is safe — counts already durable.
    await params.renewLease();
  }
  return nextCounts;
};

const processExportArtifactPage = async (
  params: ArtifactScopeProcessorParams,
  counts: PlatformAuditRetentionCounts,
): Promise<{ counts: PlatformAuditRetentionCounts; done: boolean }> => {
  await params.renewLease();
  const page = await params.repo.listExportArtifactCandidates({
    cursor: params.getKeyset(),
    cutoffAt: params.cutoffAt,
    limit: AUDIT_RETENTION_BATCH_LIMIT,
  });

  if (page.items.length === 0) return { counts, done: true };

  // Targeted hold scopes from frozen filter snapshots (F11).
  const scopeRefs = collectExportFilterHoldScopes(page.items);
  const holds = await loadHoldIndexForScopes(params.db, scopeRefs);

  const delta: PlatformAuditRetentionCounts = {
    exportArtifactsScanned: page.items.length,
    skippedLegalHold: 0,
    exportArtifactsDeleted: 0,
  };

  const freeIds: string[] = [];
  for (const art of page.items) {
    if (exportArtifactHeld(holds, art.kind, art.filterSnapshot)) {
      delta.skippedLegalHold = (delta.skippedLegalHold ?? 0) + 1;
      continue;
    }
    if (params.execute) freeIds.push(art.id);
  }

  const nextKeyset = keysetAfterPage(page, (row) => row.sortAt);
  if (!nextKeyset) return { counts, done: true };

  let claimedIds: string[] = [];

  if (params.execute && freeIds.length > 0) {
    claimedIds = await claimFreeExportArtifacts(params, {
      delta,
      freeIds,
      items: page.items,
      scopeRefs,
    });
  }

  // Durable checkpoint BEFORE object destruction: scanned / pre-filter hold
  // skips + keyset cursor. Delete attribution lands atomically with outbox
  // complete (F7) so a slow storage call that outlives the lease still counts.
  let nextCounts = await params.checkpointBatch(mergeCounts(counts, delta), nextKeyset);
  params.setKeyset(nextKeyset);

  if (params.execute && claimedIds.length > 0) {
    nextCounts = await purgeClaimedExportArtifacts(params, claimedIds, nextCounts);
  }

  if (!page.nextCursor) return { counts: nextCounts, done: true };
  return { counts: nextCounts, done: false };
};

/**
 * Export-artifact retention: claim (durable purge outbox) → authorize
 * (hold recheck) → external object delete → complete outbox.
 * Never delete from pre-filter/claim return values alone.
 * Also drains stranded purge outboxes left by prior crashes (storageKey null).
 */
export const processExportArtifacts = async (
  params: ArtifactScopeProcessorParams,
): Promise<PlatformAuditRetentionCounts> => {
  let counts = params.counts;

  // Crash recovery: claim clears storageKey, so candidates never re-scan pending
  // outboxes. Each intent carries its originating run id; finalize and count credit
  // therefore remain atomic even after a crash between checkpoint and deletion.
  if (params.execute) await drainStrandedArtifactPurges(params);

  for (;;) {
    const page = await processExportArtifactPage(params, counts);
    counts = page.counts;
    if (page.done) break;
  }

  // Re-read domain counts so complete() reflects atomic F7 increments even if
  // in-memory state diverged after a partial lease-loss recovery path.
  if (params.runId) {
    const latest = await new PlatformAuditRetentionRunModel(params.db).get(params.runId);
    if (latest?.counts) {
      counts = { ...latest.counts };
    }
  }

  return counts;
};

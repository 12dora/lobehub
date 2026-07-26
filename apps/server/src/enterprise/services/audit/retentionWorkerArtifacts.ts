/**
 * Export-artifact purge processor for audit retention (SAO-009).
 */

import {
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportKind,
  type PlatformAuditLegalHoldItem,
  type PlatformAuditLegalHoldModel,
  type PlatformAuditRetentionCounts,
  PlatformAuditRetentionRunModel,
} from '@/database/models/platform';

import {
  type AuditExportArtifactStorage,
  buildAuditExportStorageKey,
  isAuditExportAttemptsPrefix,
  isAuditExportObjectNotFoundError,
} from './exportStorage';
import { AUDIT_RETENTION_BATCH_LIMIT } from './retentionConstants';
import {
  exportArtifactHeld,
  isHoldTargetType,
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
  const scopeRefs: Array<{
    scopeId: string | null;
    scopeType: PlatformAuditLegalHoldItem['scopeType'];
  }> = [];
  for (const row of rows) {
    const snap = row.filterSnapshot;
    if (snap?.userId) scopeRefs.push({ scopeId: snap.userId, scopeType: 'user' });
    if (snap?.actorUserId) scopeRefs.push({ scopeId: snap.actorUserId, scopeType: 'user' });
    if (snap?.topicId) scopeRefs.push({ scopeId: snap.topicId, scopeType: 'topic' });
    if (snap?.sessionId) scopeRefs.push({ scopeId: snap.sessionId, scopeType: 'session' });
    if (snap?.workspaceId) scopeRefs.push({ scopeId: snap.workspaceId, scopeType: 'workspace' });
    if (snap?.targetId && snap.targetType && isHoldTargetType(snap.targetType)) {
      scopeRefs.push({
        scopeId: snap.targetId,
        scopeType: snap.targetType as PlatformAuditLegalHoldItem['scopeType'],
      });
    }
  }
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
      deleteObject: async (storageKey) => {
        // Prefer storage.deleteObject (S3 + InMemory expand attempts/ prefixes).
        // If a custom adapter lacks listObjectKeysByPrefix, refuse prefix keys so
        // the outbox stays pending instead of silently finalizing (SAO-002).
        if (isAuditExportAttemptsPrefix(storageKey) && !params.storage.listObjectKeysByPrefix) {
          throw new Error('AUDIT_EXPORT_PREFIX_LIST_REQUIRED');
        }
        await params.storage.deleteObject(storageKey);
      },
      ids: params.ids,
      // HEAD reconciliation for crash-after-delete (DB-001).
      objectExists: async (storageKey) => {
        if (isAuditExportAttemptsPrefix(storageKey)) {
          if (!params.storage.listObjectKeysByPrefix) {
            throw new Error('AUDIT_EXPORT_PREFIX_LIST_REQUIRED');
          }
          const keys = await params.storage.listObjectKeysByPrefix(storageKey);
          return keys.length > 0;
        }
        try {
          await params.storage.getObjectMetadata(storageKey);
          return true;
        } catch (error) {
          if (isAuditExportObjectNotFoundError(error)) return false;
          throw error;
        }
      },
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

/**
 * Export-artifact retention: claim (durable purge outbox) → authorize
 * (hold recheck) → external object delete → complete outbox.
 * Never delete from pre-filter/claim return values alone.
 * Also drains stranded purge outboxes left by prior crashes (storageKey null).
 */
export const processExportArtifacts = async (
  params: ScopeProcessorParams & {
    afterArtifactAuthorize?: ArtifactPurgeSeams['afterArtifactAuthorize'];
    afterArtifactClaim?: ArtifactPurgeSeams['afterArtifactClaim'];
    storage?: AuditExportArtifactStorage;
  },
): Promise<PlatformAuditRetentionCounts> => {
  let counts = params.counts;

  // Crash recovery: claim clears storageKey, so candidates never re-scan pending
  // outboxes. Each intent carries its originating run id; finalize and count credit
  // therefore remain atomic even after a crash between checkpoint and deletion.
  if (params.execute) {
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
  }

  for (;;) {
    await params.renewLease();
    const page = await params.repo.listExportArtifactCandidates({
      cursor: params.getKeyset(),
      cutoffAt: params.cutoffAt,
      limit: AUDIT_RETENTION_BATCH_LIMIT,
    });

    if (page.items.length === 0) break;

    // Targeted hold scopes from frozen filter snapshots (F11).
    const scopeRefs: Array<{
      scopeId: string | null;
      scopeType: PlatformAuditLegalHoldItem['scopeType'];
    }> = [];
    for (const art of page.items) {
      const snap = art.filterSnapshot;
      if (snap?.userId) scopeRefs.push({ scopeId: snap.userId, scopeType: 'user' });
      if (snap?.actorUserId) scopeRefs.push({ scopeId: snap.actorUserId, scopeType: 'user' });
      if (snap?.topicId) scopeRefs.push({ scopeId: snap.topicId, scopeType: 'topic' });
      if (snap?.sessionId) scopeRefs.push({ scopeId: snap.sessionId, scopeType: 'session' });
      if (snap?.workspaceId) scopeRefs.push({ scopeId: snap.workspaceId, scopeType: 'workspace' });
      if (snap?.targetId && snap.targetType && isHoldTargetType(snap.targetType)) {
        scopeRefs.push({
          scopeId: snap.targetId,
          scopeType: snap.targetType as PlatformAuditLegalHoldItem['scopeType'],
        });
      }
    }
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
    if (!nextKeyset) break;

    let claimedIds: string[] = [];

    if (params.execute && freeIds.length > 0) {
      // Phase 1: under lock, recheck holds + durable tombstone claim (outbox).
      // Outbox is the pre-destruction journal; never delete objects before the
      // durable run/job checkpoint for this page.
      const claimed = await params.repo.claimExportArtifactsRechecked({
        cutoffAt: params.cutoffAt,
        ids: freeIds,
        resolveHeldIds: resolveExportArtifactHeldIds,
        runId: params.runId,
      });
      claimedIds = claimed.map((c) => c.id);

      if (claimed.length < freeIds.length) {
        // Pre-filter free → claim skipped: count only those still held (not
        // concurrent eligibility races).
        const claimedSet = new Set(claimedIds);
        const holdsNow = await loadHoldIndexForScopes(params.db, scopeRefs);
        for (const id of freeIds) {
          if (claimedSet.has(id)) continue;
          const art = page.items.find((r) => r.id === id);
          if (art && exportArtifactHeld(holdsNow, art.kind, art.filterSnapshot)) {
            delta.skippedLegalHold = (delta.skippedLegalHold ?? 0) + 1;
          }
        }
      }

      if (params.afterArtifactClaim) {
        await params.afterArtifactClaim({
          claimed: claimed.map((c) => ({ id: c.id, storageKey: c.storageKey })),
        });
      }
    }

    // Durable checkpoint BEFORE object destruction: scanned / pre-filter hold
    // skips + keyset cursor. Delete attribution lands atomically with outbox
    // complete (F7) so a slow storage call that outlives the lease still counts.
    counts = await params.checkpointBatch(mergeCounts(counts, delta), nextKeyset);
    params.setKeyset(nextKeyset);

    if (params.execute && claimedIds.length > 0) {
      if (!params.storage) {
        throw new Error('AUDIT_RETENTION_ARTIFACT_STORAGE_REQUIRED');
      }

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
          counts = mergeCounts(counts, {
            exportArtifactsDeleted: result.deleted,
            skippedLegalHold: result.skippedHold,
          });
        }
        // Heartbeat after each object; LeaseLost is safe — counts already durable.
        await params.renewLease();
      }
    }

    if (!page.nextCursor) break;
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

/** Process up to `batchLimit` retention jobs (for poller / tests). */

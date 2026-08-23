/**
 * Functional worker for platform.audit.retention.v1 jobs (dry_run + execute).
 *
 * Keyset-batched scans, lease renewal, cancellation checks between batches.
 * Counts + job cursor checkpoint atomically (no double-count on retry).
 * Final page always persists a cursor past the last processed item.
 * Lease loss is NOT user cancellation — domain/job stay open for reclaim.
 * Legal-hold skips advance the cursor (no infinite loops).
 * Invalid run/job data is terminal.
 */

import {
  type PlatformAuditRetentionCounts,
  PlatformAuditRetentionRepository,
  type PlatformAuditRetentionRunItem,
  PlatformAuditRetentionRunModel,
  PlatformJobModel,
} from '@/database/models/platform';
import type { PlatformJobItem } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { AuditExportArtifactStorage } from './exportStorage';
import {
  AUDIT_RETENTION_DEFAULT_LEASE_MS,
  parseAuditRetentionJobCursor,
  parseAuditRetentionJobInput,
  PLATFORM_AUDIT_RETENTION_JOB_TYPE,
} from './retentionConstants';
import { createRetentionBatchCheckpoint } from './retentionWorkerCheckpoint';
import { AuditRetentionInvalidDataError } from './retentionWorkerErrors';
import {
  completeRetentionRun,
  prepareRetentionRun,
  processRetentionScope,
} from './retentionWorkerExecute';
import { settleRetentionJobError } from './retentionWorkerFailure';

export interface ProcessNextAuditRetentionOptions {
  /**
   * Test seam: after preliminary authorize returns free and immediately before
   * lock-held purge (final recheck + object delete under the advisory lock).
   * Insert a legal hold here to exercise the authorize→delete race.
   */
  afterArtifactAuthorize?: (info: {
    authorized: Array<{ id: string; storageKey: string }>;
  }) => Promise<void> | void;
  /**
   * Test seam: after export-artifact purge claim (outbox written, storageKey
   * cleared) and before authorize + object delete. Insert a legal hold here to
   * exercise the claim→authorize race.
   */
  afterArtifactClaim?: (info: {
    claimed: Array<{ id: string; storageKey: string }>;
  }) => Promise<void> | void;
  /**
   * Test seam: invoked after each successful atomic batch checkpoint.
   * Throw to simulate transient failure after progress/cursor are durable.
   */
  afterBatchCheckpoint?: (info: {
    batchIndex: number;
    counts: PlatformAuditRetentionCounts;
    keyset: string | undefined;
  }) => Promise<void> | void;
  /**
   * Test seam: after domain `complete` succeeds, before `jobs.complete`.
   * Used to simulate final-step lease loss without cancelling the domain.
   */
  afterDomainComplete?: (info: { jobId: string; runId: string }) => Promise<void> | void;
  /**
   * Already-claimed job. When set, this entry point skips `claimNext` so a
   * mixed-type dispatcher can own the SELECT … FOR UPDATE SKIP LOCKED.
   */
  claimed?: PlatformJobItem;
  leaseMs?: number;
  storage?: AuditExportArtifactStorage;
  workerId: string;
}

export interface ProcessNextAuditRetentionResult {
  claimed: boolean;
  jobId?: string;
  outcome?: 'cancelled' | 'completed' | 'failed' | 'retry' | 'skipped';
  runId?: string;
}

/** Explicit domain/job cancellation only — never lease loss. */
export { AuditRetentionLeaseLostError, isTerminalContractError } from './retentionWorkerErrors';

export const processNextAuditRetentionJob = async (
  db: LobeChatDatabase,
  options: ProcessNextAuditRetentionOptions,
): Promise<ProcessNextAuditRetentionResult> => {
  const jobs = new PlatformJobModel(db);
  const runsModel = new PlatformAuditRetentionRunModel(db);
  const repo = new PlatformAuditRetentionRepository(db);
  const leaseMs = options.leaseMs ?? AUDIT_RETENTION_DEFAULT_LEASE_MS;
  // Storage is only resolved when export_artifacts execute needs it.
  let storage: AuditExportArtifactStorage | undefined = options.storage;

  const claimed =
    options.claimed ??
    (await jobs.claimNext({
      leaseMs,
      types: [PLATFORM_AUDIT_RETENTION_JOB_TYPE],
      workerId: options.workerId,
    }));
  if (!claimed) return { claimed: false };

  const parsedInput = parseAuditRetentionJobInput(claimed.input);
  if (!parsedInput) {
    await jobs.fail({
      error: { code: 'INVALID_INPUT' },
      jobId: claimed.id,
      terminal: true,
      workerId: options.workerId,
    });
    return { claimed: true, jobId: claimed.id, outcome: 'failed' };
  }

  const runId = parsedInput.runId;

  try {
    const prepared = await prepareRetentionRun({
      jobId: claimed.id,
      jobs,
      runId,
      runsModel,
      workerId: options.workerId,
    });
    if (prepared.result) return prepared.result;
    const run = prepared.run;

    let counts: PlatformAuditRetentionCounts = { ...run.counts };
    // Resume cursor from job (never re-scan already advanced keyset).
    const resumeCursor = parseAuditRetentionJobCursor(claimed.cursor);
    if (claimed.cursor != null && resumeCursor === null) {
      throw new AuditRetentionInvalidDataError('Invalid job cursor');
    }
    let keyset: string | undefined = resumeCursor?.keyset ?? undefined;

    const { assertNotCancelled, checkpointBatch, renewLease } = createRetentionBatchCheckpoint({
      afterBatchCheckpoint: options.afterBatchCheckpoint,
      db,
      getCounts: () => counts,
      getKeyset: () => keyset,
      jobId: claimed.id,
      jobs,
      leaseMs,
      runId,
      runsModel,
      setCounts: (next) => {
        counts = next;
      },
      setKeyset: (next) => {
        keyset = next;
      },
      workerId: options.workerId,
    });

    await renewLease();

    const scoped = await processRetentionScope({
      afterArtifactAuthorize: options.afterArtifactAuthorize,
      afterArtifactClaim: options.afterArtifactClaim,
      checkpointBatch,
      counts,
      cutoffAt: run.cutoffAt,
      db,
      execute: run.mode === 'execute',
      getKeyset: () => keyset,
      renewLease,
      repo,
      runId,
      scope: run.scope,
      setKeyset: (c) => {
        keyset = c;
      },
      storage,
    });
    counts = scoped.counts;
    storage = scoped.storage;

    await assertNotCancelled();
    await renewLease();

    // Ensure sessionsDeleted is explicit 0 for conversation scope
    if (run.scope === 'conversations') {
      counts = { ...counts, sessionsDeleted: 0 };
    }

    // Seam before terminal TX so lease-loss tests can steal ownership without
    // leaving domain completed while the job/audit remain open (F5).
    if (options.afterDomainComplete) {
      await options.afterDomainComplete({ jobId: claimed.id, runId });
    }

    const terminal = await completeRetentionRun({
      counts,
      db,
      jobId: claimed.id,
      mode: run.mode,
      requestedBy: run.requestedBy,
      runId,
      scope: run.scope,
      workerId: options.workerId,
    });

    if (terminal === 'cancelled') {
      await jobs.cancel(claimed.id);
      return { claimed: true, jobId: claimed.id, outcome: 'cancelled', runId };
    }

    return { claimed: true, jobId: claimed.id, outcome: 'completed', runId };
  } catch (error) {
    return settleRetentionJobError({
      db,
      error,
      jobId: claimed.id,
      runId,
      workerId: options.workerId,
    });
  }
};

export const runAuditRetentionBatches = async (
  db: LobeChatDatabase,
  params: {
    batchLimit?: number;
    storage?: AuditExportArtifactStorage;
    workerId: string;
  },
): Promise<number> => {
  const limit = Math.max(1, params.batchLimit ?? 5);
  let processed = 0;
  while (processed < limit) {
    const result = await processNextAuditRetentionJob(db, {
      storage: params.storage,
      workerId: params.workerId,
    });
    if (!result.claimed) break;
    processed += 1;
  }
  return processed;
};

export type { PlatformAuditRetentionRunItem };

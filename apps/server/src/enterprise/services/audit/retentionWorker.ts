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
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { type AuditExportArtifactStorage, AuditExportPrivateS3Storage } from './exportStorage';
import { mapRetentionFailureCode } from './jobError';
import {
  AUDIT_RETENTION_DEFAULT_LEASE_MS,
  type AuditRetentionJobCursor,
  parseAuditRetentionJobCursor,
  parseAuditRetentionJobInput,
  PLATFORM_AUDIT_RETENTION_JOB_TYPE,
} from './retentionConstants';
import { processExportArtifacts } from './retentionWorkerArtifacts';
import {
  AuditRetentionCancelledError,
  AuditRetentionInvalidDataError,
  AuditRetentionLeaseLostError,
  isTerminalContractError,
} from './retentionWorkerErrors';
import { processConversations, processOperationLogs } from './retentionWorkerScopes';
import { progressFromCounts } from './retentionWorkerShared';
import { appendWorkerOutcome } from './retentionWorkerTerminal';

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

  const claimed = await jobs.claimNext({
    leaseMs,
    types: [PLATFORM_AUDIT_RETENTION_JOB_TYPE],
    workerId: options.workerId,
  });
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
    const run = await runsModel.get(runId);
    if (!run) {
      await jobs.fail({
        error: { code: 'NOT_FOUND' },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      return { claimed: true, jobId: claimed.id, outcome: 'failed', runId };
    }

    if (run.status === 'cancelled') {
      await jobs.cancel(claimed.id);
      return { claimed: true, jobId: claimed.id, outcome: 'cancelled', runId };
    }

    if (run.status === 'completed') {
      await jobs.complete({
        jobId: claimed.id,
        resultSummary: { runId, counts: run.counts },
        workerId: options.workerId,
      });
      return { claimed: true, jobId: claimed.id, outcome: 'skipped', runId };
    }

    if (run.status === 'failed') {
      await jobs.fail({
        error: { code: 'RUN_TERMINAL' },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      return { claimed: true, jobId: claimed.id, outcome: 'skipped', runId };
    }

    if (!run.cutoffAt || Number.isNaN(run.cutoffAt.getTime())) {
      throw new AuditRetentionInvalidDataError('Invalid cutoffAt on retention run');
    }
    if (
      run.scope !== 'operation_logs' &&
      run.scope !== 'conversations' &&
      run.scope !== 'export_artifacts'
    ) {
      throw new AuditRetentionInvalidDataError(`Invalid retention scope: ${String(run.scope)}`);
    }
    if (run.mode !== 'dry_run' && run.mode !== 'execute') {
      throw new AuditRetentionInvalidDataError(`Invalid retention mode: ${String(run.mode)}`);
    }

    // pending → running (or re-enter running after lease recovery / retry)
    if (run.status === 'pending') {
      await runsModel.updateProgress(runId, {
        markRunning: true,
        counts: run.counts ?? {},
      });
    }

    let counts: PlatformAuditRetentionCounts = { ...run.counts };
    // Resume cursor from job (never re-scan already advanced keyset).
    const resumeCursor = parseAuditRetentionJobCursor(claimed.cursor);
    if (claimed.cursor != null && resumeCursor === null) {
      throw new AuditRetentionInvalidDataError('Invalid job cursor');
    }
    let keyset: string | undefined = resumeCursor?.keyset ?? undefined;
    let batchIndex = 0;

    /** Explicit cancel only (domain or platform job status). */
    const assertNotCancelled = async () => {
      const current = await runsModel.get(runId);
      if (!current || current.status === 'cancelled') {
        throw new AuditRetentionCancelledError();
      }
      const job = await jobs.findById(claimed.id);
      if (!job || job.status === 'cancelled') {
        throw new AuditRetentionCancelledError();
      }
    };

    /**
     * Atomic DB checkpoint: optional destructive work + retention run counts/progress
     * + platform job cursor/lease in one transaction.
     * Either all commit or all roll back. Null job checkpoint → LeaseLost (not cancel).
     * Always writes cursor for the last processed item, including final page.
     */
    const checkpointBatch = async (
      nextCounts: PlatformAuditRetentionCounts,
      nextKeyset: string,
      destructiveWork?: (tx: Transaction) => Promise<PlatformAuditRetentionCounts | void>,
    ): Promise<PlatformAuditRetentionCounts> => {
      await assertNotCancelled();

      let committedCounts = nextCounts;

      await db.transaction(async (tx) => {
        if (destructiveWork) {
          const adjusted = await destructiveWork(tx);
          if (adjusted) committedCounts = adjusted;
        }

        const runsTx = new PlatformAuditRetentionRunModel(tx);
        const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);

        const updated = await runsTx.updateProgress(runId, {
          counts: committedCounts,
          progressDone: progressFromCounts(committedCounts),
        });
        if (!updated) {
          // Domain became terminal mid-batch (explicit cancel race).
          throw new AuditRetentionCancelledError();
        }

        const cursorPayload: AuditRetentionJobCursor = { keyset: nextKeyset, v: 1 };
        const cp = await jobsTx.checkpoint({
          cursor: cursorPayload,
          jobId: claimed.id,
          leaseMs,
          progressDone: progressFromCounts(committedCounts),
          workerId: options.workerId,
        });
        if (!cp) {
          // Lease owner changed / lease expired — roll back progress write with the tx.
          throw new AuditRetentionLeaseLostError();
        }
      });

      keyset = nextKeyset;
      counts = committedCounts;
      batchIndex += 1;

      if (options.afterBatchCheckpoint) {
        await options.afterBatchCheckpoint({
          batchIndex,
          counts: committedCounts,
          keyset: nextKeyset,
        });
      }

      return committedCounts;
    };

    /** Heartbeat lease without advancing counts (pre-scan / between scopes). */
    const renewLease = async () => {
      await assertNotCancelled();
      const cursorPayload: AuditRetentionJobCursor = { keyset: keyset ?? null, v: 1 };
      const cp = await jobs.checkpoint({
        cursor: cursorPayload,
        jobId: claimed.id,
        leaseMs,
        progressDone: progressFromCounts(counts),
        workerId: options.workerId,
      });
      if (!cp) {
        throw new AuditRetentionLeaseLostError();
      }
    };

    await renewLease();

    if (run.scope === 'operation_logs') {
      counts = await processOperationLogs({
        checkpointBatch,
        counts,
        cutoffAt: run.cutoffAt,
        db,
        execute: run.mode === 'execute',
        getKeyset: () => keyset,
        renewLease,
        repo,
        setKeyset: (c) => {
          keyset = c;
        },
      });
    } else if (run.scope === 'conversations') {
      counts = await processConversations({
        checkpointBatch,
        counts,
        cutoffAt: run.cutoffAt,
        db,
        execute: run.mode === 'execute',
        getKeyset: () => keyset,
        renewLease,
        repo,
        setKeyset: (c) => {
          keyset = c;
        },
      });
    } else {
      if (run.mode === 'execute' && !storage) {
        storage = new AuditExportPrivateS3Storage();
      }
      counts = await processExportArtifacts({
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
        setKeyset: (c) => {
          keyset = c;
        },
        storage,
      });
    }

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

    // Domain complete + job succeed + required outcome audit in one TX (F5).
    const terminal = await db.transaction(async (tx) => {
      const runsTx = new PlatformAuditRetentionRunModel(tx);
      const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);

      const completed = await runsTx.complete(runId, { counts });
      if (!completed) {
        return 'cancelled' as const;
      }

      const jobDone = await jobsTx.complete({
        jobId: claimed.id,
        resultSummary: {
          counts,
          mode: run.mode,
          runId,
          scope: run.scope,
        },
        workerId: options.workerId,
      });
      if (!jobDone) {
        // Lease ownership lost — roll back domain complete with this TX.
        throw new AuditRetentionLeaseLostError();
      }

      await appendWorkerOutcome(tx, {
        counts,
        mode: run.mode,
        outcome: 'completed',
        requestedBy: run.requestedBy,
        required: true,
        result: 'success',
        runId,
        scope: run.scope,
      });

      return 'completed' as const;
    });

    if (terminal === 'cancelled') {
      await jobs.cancel(claimed.id);
      return { claimed: true, jobId: claimed.id, outcome: 'cancelled', runId };
    }

    return { claimed: true, jobId: claimed.id, outcome: 'completed', runId };
  } catch (error) {
    if (error instanceof AuditRetentionLeaseLostError) {
      // Lease loss is NOT user cancellation — leave domain + platform job as-is for reclaim.
      return { claimed: true, jobId: claimed.id, outcome: 'skipped', runId };
    }

    if (error instanceof AuditRetentionCancelledError) {
      await db.transaction(async (tx) => {
        const runsTx = new PlatformAuditRetentionRunModel(tx);
        const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);
        await runsTx.cancel(runId);
        await jobsTx.cancel(claimed.id);
        const cancelledRun = await runsTx.get(runId);
        if (cancelledRun) {
          await appendWorkerOutcome(tx, {
            counts: cancelledRun.counts,
            mode: cancelledRun.mode,
            outcome: 'cancelled',
            requestedBy: cancelledRun.requestedBy,
            required: true,
            result: 'success',
            runId,
            scope: cancelledRun.scope,
          });
        }
      });
      return { claimed: true, jobId: claimed.id, outcome: 'cancelled', runId };
    }

    // Bounded enum only — never Error.name / free-form message as public code (F3).
    const code =
      error instanceof AuditRetentionInvalidDataError
        ? 'INVALID_INPUT'
        : mapRetentionFailureCode(error);

    if (isTerminalContractError(error)) {
      await runsModel.fail(runId, { code });
      await jobs.fail({
        error: { code },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      const run = await runsModel.get(runId);
      if (run) {
        await appendWorkerOutcome(db, {
          errorCode: code,
          mode: run.mode,
          outcome: 'failed',
          requestedBy: run.requestedBy,
          required: true,
          result: 'failure',
          runId,
          scope: run.scope,
        });
      }
      return { claimed: true, jobId: claimed.id, outcome: 'failed', runId };
    }

    // Transient: requeue job (or dead when maxAttempts exhausted). Domain stays running.
    const failedJob = await jobs.fail({
      error: { code },
      jobId: claimed.id,
      workerId: options.workerId,
    });

    if (failedJob?.status === 'dead') {
      await runsModel.fail(runId, { code });
      const run = await runsModel.get(runId);
      if (run) {
        await appendWorkerOutcome(db, {
          errorCode: code,
          mode: run.mode,
          outcome: 'failed',
          requestedBy: run.requestedBy,
          required: true,
          result: 'failure',
          runId,
          scope: run.scope,
        });
      }
      return { claimed: true, jobId: claimed.id, outcome: 'failed', runId };
    }

    return { claimed: true, jobId: claimed.id, outcome: 'retry', runId };
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

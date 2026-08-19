/**
 * Durable batch checkpoint + lease heartbeat for retention worker.
 *
 * Counts + job cursor commit atomically. Lease loss rolls back the TX
 * (not user cancellation). Heartbeat renews the lease without advancing counts.
 */

import type { PlatformAuditRetentionCounts } from '@/database/models/platform';
import { PlatformAuditRetentionRunModel, PlatformJobModel } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AuditRetentionJobCursor } from './retentionConstants';
import {
  AuditRetentionCancelledError,
  AuditRetentionLeaseLostError,
} from './retentionWorkerErrors';
import type { ScopeProcessorParams } from './retentionWorkerShared';
import { progressFromCounts } from './retentionWorkerShared';

export interface CreateRetentionBatchCheckpointParams {
  /**
   * Test seam: invoked after each successful atomic batch checkpoint.
   * Throw to simulate transient failure after progress/cursor are durable.
   */
  afterBatchCheckpoint?: (info: {
    batchIndex: number;
    counts: PlatformAuditRetentionCounts;
    keyset: string | undefined;
  }) => Promise<void> | void;
  db: LobeChatDatabase;
  getCounts: () => PlatformAuditRetentionCounts;
  getKeyset: () => string | undefined;
  jobId: string;
  jobs: PlatformJobModel;
  leaseMs: number;
  runId: string;
  runsModel: PlatformAuditRetentionRunModel;
  setCounts: (counts: PlatformAuditRetentionCounts) => void;
  setKeyset: (keyset: string | undefined) => void;
  workerId: string;
}

export interface RetentionBatchCheckpoint {
  /** Explicit cancel only (domain or platform job status). */
  assertNotCancelled: () => Promise<void>;
  checkpointBatch: ScopeProcessorParams['checkpointBatch'];
  /** Heartbeat lease without advancing counts (pre-scan / between scopes). */
  renewLease: () => Promise<void>;
}

export const createRetentionBatchCheckpoint = (
  params: CreateRetentionBatchCheckpointParams,
): RetentionBatchCheckpoint => {
  const {
    afterBatchCheckpoint,
    db,
    getCounts,
    getKeyset,
    jobId,
    jobs,
    leaseMs,
    runId,
    runsModel,
    setCounts,
    setKeyset,
    workerId,
  } = params;

  let batchIndex = 0;

  /** Explicit cancel only (domain or platform job status). */
  const assertNotCancelled = async () => {
    const current = await runsModel.get(runId);
    if (!current || current.status === 'cancelled') {
      throw new AuditRetentionCancelledError();
    }
    const job = await jobs.findById(jobId);
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
        jobId,
        leaseMs,
        progressDone: progressFromCounts(committedCounts),
        workerId,
      });
      if (!cp) {
        // Lease owner changed / lease expired — roll back progress write with the tx.
        throw new AuditRetentionLeaseLostError();
      }
    });

    setKeyset(nextKeyset);
    setCounts(committedCounts);
    batchIndex += 1;

    if (afterBatchCheckpoint) {
      await afterBatchCheckpoint({
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
    const cursorPayload: AuditRetentionJobCursor = { keyset: getKeyset() ?? null, v: 1 };
    const cp = await jobs.checkpoint({
      cursor: cursorPayload,
      jobId,
      leaseMs,
      progressDone: progressFromCounts(getCounts()),
      workerId,
    });
    if (!cp) {
      throw new AuditRetentionLeaseLostError();
    }
  };

  return { assertNotCancelled, checkpointBatch, renewLease };
};

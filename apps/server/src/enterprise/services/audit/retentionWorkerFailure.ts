/** Terminal / transient failure settlement for a claimed retention job. */

import { PlatformAuditRetentionRunModel, PlatformJobModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import { mapRetentionFailureCode } from './jobError';
import type { ProcessNextAuditRetentionResult } from './retentionWorker';
import {
  AuditRetentionCancelledError,
  AuditRetentionInvalidDataError,
  AuditRetentionLeaseLostError,
  isTerminalContractError,
} from './retentionWorkerErrors';
import { appendWorkerOutcome, failRetentionAttempt } from './retentionWorkerTerminal';

export const settleRetentionJobError = async (params: {
  db: LobeChatDatabase;
  error: unknown;
  jobId: string;
  runId: string;
  workerId: string;
}): Promise<ProcessNextAuditRetentionResult> => {
  const { db, error, jobId, runId, workerId } = params;

  if (error instanceof AuditRetentionLeaseLostError) {
    // Lease loss is NOT user cancellation — leave domain + platform job as-is for reclaim.
    return { claimed: true, jobId, outcome: 'skipped', runId };
  }

  if (error instanceof AuditRetentionCancelledError) {
    await db.transaction(async (tx) => {
      const runsTx = new PlatformAuditRetentionRunModel(tx);
      const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);
      await runsTx.cancel(runId);
      await jobsTx.cancel(jobId);
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
    return { claimed: true, jobId, outcome: 'cancelled', runId };
  }

  // Bounded enum only — never Error.name / free-form message as public code (F3).
  const code =
    error instanceof AuditRetentionInvalidDataError
      ? 'INVALID_INPUT'
      : mapRetentionFailureCode(error);

  if (isTerminalContractError(error)) {
    await failRetentionAttempt(db, {
      code,
      jobId,
      runId,
      terminal: true,
      workerId,
    });
    return { claimed: true, jobId, outcome: 'failed', runId };
  }

  // Transient: requeue, or atomically terminalize all evidence when exhausted.
  const terminal = await failRetentionAttempt(db, {
    code,
    jobId,
    runId,
    terminal: false,
    workerId,
  });

  if (terminal) {
    return { claimed: true, jobId, outcome: 'failed', runId };
  }

  return { claimed: true, jobId, outcome: 'retry', runId };
};

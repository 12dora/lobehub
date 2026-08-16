/** Domain-status short-circuits and validity assertions for a claimed retention run. */

import type { PlatformAuditRetentionRunItem, PlatformJobModel } from '@/database/models/platform';

import type { ProcessNextAuditRetentionResult } from './retentionWorker';
import { AuditRetentionInvalidDataError } from './retentionWorkerErrors';

export const settleNonRunnableRun = async (params: {
  jobId: string;
  jobs: PlatformJobModel;
  run: PlatformAuditRetentionRunItem;
  runId: string;
  workerId: string;
}): Promise<ProcessNextAuditRetentionResult | null> => {
  const { jobId, jobs, run, runId, workerId } = params;

  if (run.status === 'cancelled') {
    await jobs.cancel(jobId);
    return { claimed: true, jobId, outcome: 'cancelled', runId };
  }

  if (run.status === 'completed') {
    await jobs.complete({
      jobId,
      resultSummary: { runId, counts: run.counts },
      workerId,
    });
    return { claimed: true, jobId, outcome: 'skipped', runId };
  }

  if (run.status === 'failed') {
    await jobs.fail({
      error: { code: 'RUN_TERMINAL' },
      jobId,
      terminal: true,
      workerId,
    });
    return { claimed: true, jobId, outcome: 'skipped', runId };
  }

  return null;
};

export const assertRunnableRun = (run: PlatformAuditRetentionRunItem): void => {
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
};

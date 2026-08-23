/**
 * Scope dispatch and terminal complete TX for audit retention jobs.
 * Domain complete + job succeed + required outcome audit stay in one TX (F5).
 */

import type {
  PlatformAuditRetentionCounts,
  PlatformAuditRetentionRepository,
  PlatformAuditRetentionRunItem,
} from '@/database/models/platform';
import { PlatformAuditRetentionRunModel, PlatformJobModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import { type AuditExportArtifactStorage, AuditExportPrivateS3Storage } from './exportStorage';
import type {
  ProcessNextAuditRetentionOptions,
  ProcessNextAuditRetentionResult,
} from './retentionWorker';
import { processExportArtifacts } from './retentionWorkerArtifacts';
import { assertRunnableRun, settleNonRunnableRun } from './retentionWorkerClaim';
import { AuditRetentionLeaseLostError } from './retentionWorkerErrors';
import { processConversations, processOperationLogs } from './retentionWorkerScopes';
import type { ScopeProcessorParams } from './retentionWorkerShared';
import { appendWorkerOutcome } from './retentionWorkerTerminal';

export const prepareRetentionRun = async (params: {
  jobId: string;
  jobs: PlatformJobModel;
  runId: string;
  runsModel: PlatformAuditRetentionRunModel;
  workerId: string;
}): Promise<
  | { result: ProcessNextAuditRetentionResult; run?: undefined }
  | { result?: undefined; run: PlatformAuditRetentionRunItem }
> => {
  const run = await params.runsModel.get(params.runId);
  if (!run) {
    await params.jobs.fail({
      error: { code: 'NOT_FOUND' },
      jobId: params.jobId,
      terminal: true,
      workerId: params.workerId,
    });
    return {
      result: { claimed: true, jobId: params.jobId, outcome: 'failed', runId: params.runId },
    };
  }

  const settled = await settleNonRunnableRun({
    jobId: params.jobId,
    jobs: params.jobs,
    run,
    runId: params.runId,
    workerId: params.workerId,
  });
  if (settled) return { result: settled };

  assertRunnableRun(run);

  // pending → running (or re-enter running after lease recovery / retry)
  if (run.status === 'pending') {
    await params.runsModel.updateProgress(params.runId, {
      markRunning: true,
      counts: run.counts ?? {},
    });
  }

  return { run };
};

export const processRetentionScope = async (params: {
  afterArtifactAuthorize?: ProcessNextAuditRetentionOptions['afterArtifactAuthorize'];
  afterArtifactClaim?: ProcessNextAuditRetentionOptions['afterArtifactClaim'];
  checkpointBatch: ScopeProcessorParams['checkpointBatch'];
  counts: PlatformAuditRetentionCounts;
  cutoffAt: Date;
  db: LobeChatDatabase;
  execute: boolean;
  getKeyset: () => string | undefined;
  renewLease: () => Promise<void>;
  repo: PlatformAuditRetentionRepository;
  runId: string;
  scope: PlatformAuditRetentionRunItem['scope'];
  setKeyset: (cursor: string | undefined) => void;
  storage: AuditExportArtifactStorage | undefined;
}): Promise<{
  counts: PlatformAuditRetentionCounts;
  storage: AuditExportArtifactStorage | undefined;
}> => {
  let { counts, storage } = params;

  if (params.scope === 'operation_logs') {
    counts = await processOperationLogs({
      checkpointBatch: params.checkpointBatch,
      counts,
      cutoffAt: params.cutoffAt,
      db: params.db,
      execute: params.execute,
      getKeyset: params.getKeyset,
      renewLease: params.renewLease,
      repo: params.repo,
      setKeyset: params.setKeyset,
    });
  } else if (params.scope === 'conversations') {
    counts = await processConversations({
      checkpointBatch: params.checkpointBatch,
      counts,
      cutoffAt: params.cutoffAt,
      db: params.db,
      execute: params.execute,
      getKeyset: params.getKeyset,
      renewLease: params.renewLease,
      repo: params.repo,
      setKeyset: params.setKeyset,
    });
  } else {
    if (params.execute && !storage) {
      storage = new AuditExportPrivateS3Storage();
    }
    counts = await processExportArtifacts({
      afterArtifactAuthorize: params.afterArtifactAuthorize,
      afterArtifactClaim: params.afterArtifactClaim,
      checkpointBatch: params.checkpointBatch,
      counts,
      cutoffAt: params.cutoffAt,
      db: params.db,
      execute: params.execute,
      getKeyset: params.getKeyset,
      renewLease: params.renewLease,
      repo: params.repo,
      runId: params.runId,
      setKeyset: params.setKeyset,
      storage,
    });
  }

  return { counts, storage };
};

/** Domain complete + job succeed + required outcome audit in one TX (F5). */
export const completeRetentionRun = async (params: {
  counts: PlatformAuditRetentionCounts;
  db: LobeChatDatabase;
  jobId: string;
  mode: PlatformAuditRetentionRunItem['mode'];
  requestedBy: PlatformAuditRetentionRunItem['requestedBy'];
  runId: string;
  scope: PlatformAuditRetentionRunItem['scope'];
  workerId: string;
}): Promise<'cancelled' | 'completed'> => {
  return params.db.transaction(async (tx) => {
    const runsTx = new PlatformAuditRetentionRunModel(tx);
    const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);

    const completed = await runsTx.complete(params.runId, { counts: params.counts });
    if (!completed) {
      return 'cancelled' as const;
    }

    const jobDone = await jobsTx.complete({
      jobId: params.jobId,
      resultSummary: {
        counts: params.counts,
        mode: params.mode,
        runId: params.runId,
        scope: params.scope,
      },
      workerId: params.workerId,
    });
    if (!jobDone) {
      // Lease ownership lost — roll back domain complete with this TX.
      throw new AuditRetentionLeaseLostError();
    }

    await appendWorkerOutcome(tx, {
      counts: params.counts,
      mode: params.mode,
      outcome: 'completed',
      requestedBy: params.requestedBy,
      required: true,
      result: 'success',
      runId: params.runId,
      scope: params.scope,
    });

    return 'completed' as const;
  });
};

/**
 * Terminal audit outcome append for retention worker (SAO-009).
 */

import {
  type PlatformAuditRetentionCounts,
  PlatformAuditRetentionRunModel,
  PlatformJobModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { PlatformAuditService } from '../platformAudit';
import { AuditRetentionLeaseLostError } from './retentionWorkerErrors';

export const appendWorkerOutcome = async (
  db: LobeChatDatabase | Transaction,
  params: {
    counts?: PlatformAuditRetentionCounts;
    mode: string;
    outcome: 'cancelled' | 'completed' | 'failed';
    requestedBy: string;
    result: 'success' | 'failure';
    runId: string;
    scope: string;
    errorCode?: string;
    /** Terminal outcomes require a durable audit record (fail closed). */
    required?: boolean;
  },
): Promise<void> => {
  try {
    await new PlatformAuditService(db).append({
      action: 'admin.audit.retention.worker',
      actorUserId: params.requestedBy,
      afterDiff: {
        errorCode: params.errorCode,
        mode: params.mode,
        outcome: params.outcome,
        scope: params.scope,
        ...(params.counts
          ? {
              operationLogsDeleted: params.counts.operationLogsDeleted,
              operationLogsScanned: params.counts.operationLogsScanned,
              skippedLegalHold: params.counts.skippedLegalHold,
              topicsDeleted: params.counts.topicsDeleted,
              topicsScanned: params.counts.topicsScanned,
              messagesDeleted: params.counts.messagesDeleted,
              exportArtifactsDeleted: params.counts.exportArtifactsDeleted,
              exportArtifactsScanned: params.counts.exportArtifactsScanned,
              sessionsDeleted: params.counts.sessionsDeleted,
            }
          : {}),
      },
      result: params.result,
      targetId: params.runId,
      targetType: 'audit_retention_run',
    });
  } catch (error) {
    console.error('[admin.audit] retention worker outcome audit failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      outcome: params.outcome,
      required: Boolean(params.required),
      runId: params.runId,
    });
    // Terminal outcomes must not complete silently without a durable audit trail.
    if (params.required) throw error;
  }
};

/**
 * Fail one retention attempt atomically. A non-exhausted transient failure only
 * requeues the job; a dead attempt also fails the domain run and appends its
 * required audit outcome in the same transaction.
 */
export const failRetentionAttempt = async (
  db: LobeChatDatabase,
  params: {
    code: string;
    jobId: string;
    runId: string;
    terminal: boolean;
    workerId: string;
  },
): Promise<boolean> =>
  db.transaction(async (tx) => {
    const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);
    const runsTx = new PlatformAuditRetentionRunModel(tx);
    const run = await runsTx.get(params.runId);
    if (!run) throw new AuditRetentionLeaseLostError();

    const failedJob = await jobsTx.fail({
      error: { code: params.code },
      jobId: params.jobId,
      terminal: params.terminal,
      workerId: params.workerId,
    });
    if (!failedJob) throw new AuditRetentionLeaseLostError();
    if (failedJob.status !== 'dead') return false;

    await runsTx.fail(params.runId, { code: params.code });
    await appendWorkerOutcome(tx, {
      errorCode: params.code,
      mode: run.mode,
      outcome: 'failed',
      requestedBy: run.requestedBy,
      required: true,
      result: 'failure',
      runId: params.runId,
      scope: run.scope,
    });
    return true;
  });

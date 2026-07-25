/**
 * Terminal audit outcome append for retention worker (SAO-009).
 */

import type { PlatformAuditRetentionCounts } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { PlatformAuditService } from '../platformAudit';

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
 * Claim and process at most one audit retention job.
 * Safe to call in a poller loop; returns claimed=false when the queue is empty.
 */

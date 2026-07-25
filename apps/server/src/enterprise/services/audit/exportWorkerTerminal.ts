/**
 * Export worker transactional terminalization helpers (SAO-009).
 */
/**
 * Functional worker for platform.audit.export.v1 jobs.
 * Keyset-batched DB reads, lease renewal, cancellation checks.
 * Builds NDJSON (manifest + evidence). Hard-fails if maxExportRows+1 would be written.
 * No generic redaction / summarization / body truncation; credential-only masking for messages.
 *
 * Evidence is materialised under a PostgreSQL REPEATABLE READ snapshot (plus an
 * export-start watermark on `to`) into a staging temp file so concurrent mutations
 * cannot reshape content after freeze. Staging lines are then copied into the
 * artifact with heartbeats outside the snapshot TX. NDJSON streams to a temp file
 * with incremental SHA-256 — O(batch) memory during write.
 *
 * Publication is a durable two-phase fenced state machine (SAO-001/002):
 * each attempt binds a fencing token, uploads to an attempt-unique object key,
 * renews the lease across remote I/O, and completes only if the token still owns
 * the row. Losers never delete a key they do not own.
 *
 * Reliability: unknown/transient storage/DB errors requeue via platform_jobs (maxAttempts);
 * domain stays `running` and only the attempt's own object is cleaned. Domain is marked
 * failed only when the job becomes `dead`. Contract/data errors are terminal immediately.
 * Terminal domain/job outcomes append a required audit event in the same DB transaction.
 */

import { PlatformAuditExportModel, PlatformJobModel } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { PlatformAuditService } from '../platformAudit';
import { type AuditExportArtifactStorage } from './exportStorage';
/** Defense-in-depth ceiling on artifact bytes while streaming (F10). */
import { AuditExportLeaseLostError } from './exportWorkerErrors';

export const appendExportWorkerOutcome = async (
  db: LobeChatDatabase | Transaction,
  params: {
    artifactBytes?: number;
    errorCode?: string;
    exportId: string;
    outcome: 'cancelled' | 'completed' | 'failed';
    requestedBy: string;
    required?: boolean;
    result: 'success' | 'failure';
    rowCount?: number;
    storageKey?: string;
  },
): Promise<void> => {
  try {
    await new PlatformAuditService(db).append({
      action: 'admin.audit.exports.worker',
      actorUserId: params.requestedBy,
      afterDiff: {
        errorCode: params.errorCode,
        outcome: params.outcome,
        ...(params.rowCount != null ? { rowCount: params.rowCount } : {}),
        ...(params.artifactBytes != null ? { artifactBytes: params.artifactBytes } : {}),
        ...(params.storageKey ? { storageKeyPresent: true } : {}),
      },
      result: params.result,
      targetId: params.exportId,
      targetType: 'audit_export',
    });
  } catch (error) {
    console.error('[admin.audit] export worker outcome audit failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      exportId: params.exportId,
      outcome: params.outcome,
      required: Boolean(params.required),
    });
    if (params.required) throw error;
  }
};

export const terminalCompleteExport = async (
  db: LobeChatDatabase,
  params: {
    afterDomainComplete?: () => Promise<void>;
    artifactBytes: number;
    artifactChecksum: string;
    attemptToken: string;
    evidenceCount: number;
    exportId: string;
    expiresAt: Date;
    jobId: string;
    requestedBy: string;
    storageKey: string;
    workerId: string;
  },
): Promise<Awaited<ReturnType<PlatformAuditExportModel['complete']>>> => {
  // Test seam: runs after integrity checks, before the atomic terminal TX.
  // Stealing the lease here causes jobs.complete to fail and the whole TX to roll back.
  if (params.afterDomainComplete) {
    await params.afterDomainComplete();
  }

  return db.transaction(async (tx) => {
    const exportsTx = new PlatformAuditExportModel(tx);
    const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);

    const completed = await exportsTx.complete(params.exportId, {
      artifactBytes: params.artifactBytes,
      artifactChecksum: params.artifactChecksum,
      attemptToken: params.attemptToken,
      expiresAt: params.expiresAt,
      rowCount: params.evidenceCount,
      storageKey: params.storageKey,
    });
    if (!completed) return undefined;

    const jobDone = await jobsTx.complete({
      jobId: params.jobId,
      resultSummary: {
        artifactBytes: params.artifactBytes,
        exportId: params.exportId,
        rowCount: params.evidenceCount,
      },
      workerId: params.workerId,
    });
    if (!jobDone) {
      // Lease ownership lost — roll back domain complete so reclaim can finish cleanly.
      throw new AuditExportLeaseLostError();
    }

    await appendExportWorkerOutcome(tx, {
      artifactBytes: params.artifactBytes,
      exportId: params.exportId,
      outcome: 'completed',
      requestedBy: params.requestedBy,
      required: true,
      result: 'success',
      rowCount: params.evidenceCount,
      storageKey: params.storageKey,
    });

    return completed;
  });
};

export const terminalFailExport = async (
  db: LobeChatDatabase,
  params: {
    code: string;
    exportId: string;
    jobId: string;
    requestedBy: string;
    skipJobFail?: boolean;
    terminal: boolean;
    workerId: string;
  },
): Promise<void> => {
  await db.transaction(async (tx) => {
    const exportsTx = new PlatformAuditExportModel(tx);
    const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);
    await exportsTx.fail(params.exportId, { code: params.code });
    if (!params.skipJobFail) {
      await jobsTx.fail({
        error: { code: params.code },
        jobId: params.jobId,
        terminal: params.terminal,
        workerId: params.workerId,
      });
    }
    await appendExportWorkerOutcome(tx, {
      errorCode: params.code,
      exportId: params.exportId,
      outcome: 'failed',
      requestedBy: params.requestedBy,
      required: true,
      result: 'failure',
    });
  });
};

export const terminalCancelExport = async (
  db: LobeChatDatabase,
  params: {
    exportId: string;
    jobId: string;
    requestedBy: string;
    workerId: string;
  },
): Promise<void> => {
  await db.transaction(async (tx) => {
    const exportsTx = new PlatformAuditExportModel(tx);
    const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);
    await exportsTx.cancel(params.exportId);
    await jobsTx.cancel(params.jobId);
    await appendExportWorkerOutcome(tx, {
      exportId: params.exportId,
      outcome: 'cancelled',
      requestedBy: params.requestedBy,
      required: true,
      result: 'success',
    });
  });
};

/**
 * Delete an object key this attempt owns. When domain is terminal, attach durable
 * purge outbox for *this* key only. Never call with a published key owned by a
 * completed winner of a different attempt (SAO-002).
 */
export const safeDeleteOwned = async (
  storage: AuditExportArtifactStorage,
  storageKey: string,
  exportsModel?: PlatformAuditExportModel,
  exportId?: string,
): Promise<void> => {
  if (exportsModel && exportId) {
    const row = await exportsModel.get(exportId);
    // Never attach purge to a completed export whose published key differs.
    if (row?.status === 'completed' && row.storageKey && row.storageKey !== storageKey) {
      try {
        await storage.deleteObject(storageKey);
      } catch {
        // orphan attempt key — best effort only
      }
      return;
    }
    await exportsModel.enqueueArtifactObjectPurge(exportId, storageKey);
  }
  try {
    await storage.deleteObject(storageKey);
    if (exportsModel && exportId) {
      // Fence finalize: only clear the key we just deleted (and its token if any).
      const row = await exportsModel.get(exportId);
      const err = row?.error as
        | { purgeStorageKey?: string; purgeStorageKeys?: string[]; purgeToken?: string }
        | null
        | undefined;
      const token = err?.purgeToken;
      await exportsModel.completeArtifactObjectDelete(exportId, undefined, token, storageKey);
    }
  } catch {
    if (exportsModel && exportId) {
      await exportsModel.enqueueArtifactObjectPurge(exportId, storageKey);
    }
  }
};

/**
 * Materialise full evidence rows under one REPEATABLE READ snapshot into a
 * staging NDJSON file (SAO-003). Content is frozen at snapshot time — later
 * live mutations cannot alter the artifact. Heartbeats must NOT run against the
 * outer connection while this TX is open (PGlite single-connection deadlock).
 */

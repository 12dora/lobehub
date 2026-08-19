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

import type { PlatformAuditExportItem } from '@/database/models/platform';
import {
  PlatformAuditExportModel,
  PlatformAuditPolicyModel,
  PlatformJobModel,
} from '@/database/models/platform';
import type { PlatformJobItem } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { assertConversationAccessEnabled } from './contentPolicy';
import {
  AUDIT_EXPORT_DEFAULT_LEASE_MS,
  AUDIT_EXPORT_MAX_ARTIFACT_BYTES,
  parseAuditExportJobInput,
  PLATFORM_AUDIT_EXPORT_JOB_TYPE,
} from './exportConstants';
import type { AuditExportArtifactStorage } from './exportStorage';
import {
  AuditExportPrivateS3Storage,
  buildAuditExportAttemptStorageKey,
  buildAuditExportAttemptToken,
} from './exportStorage';
import { settleNonRunnableExport } from './exportWorkerClaim';
import { AuditExportLeaseLostError } from './exportWorkerErrors';
import { settleExportJobFailure } from './exportWorkerFailure';
import { resolveExportExecutionPlan } from './exportWorkerPlan';
import { runFencedExportPublication } from './exportWorkerRun';
import { terminalFailExport } from './exportWorkerTerminal';

export { AUDIT_EXPORT_MAX_ARTIFACT_BYTES } from './exportConstants';
export { AuditExportLeaseLostError, isTerminalContractError } from './exportWorkerErrors';
export { jsonlLine, toIso } from './exportWorkerShared';

export interface ProcessNextAuditExportOptions {
  /**
   * Test seam: after successful object upload (+ integrity checks), before domain complete.
   * Used to simulate process crash / lease loss after an uploaded object may exist (F6).
   */
  afterArtifactUpload?: (info: {
    exportId: string;
    jobId: string;
    storageKey: string;
  }) => Promise<void> | void;
  /**
   * Test seam: after integrity checks + upload succeed, **before** the terminal
   * domain/job/audit transaction (SAO-004). Stealing the lease here causes the
   * whole terminal TX to roll back — domain stays non-completed for reclaim.
   */
  afterDomainComplete?: (info: { exportId: string; jobId: string }) => Promise<void> | void;
  /**
   * Test seam: inject the artifact write stream (SAO-006). Defaults to
   * `createWriteStream(tmpPath)`. Used to prove async stream errors after
   * `write()===true` follow the bounded failure path without process death.
   */
  /**
   * Already-claimed job. When set, this entry point skips `claimNext` so a
   * mixed-type dispatcher can own the SELECT … FOR UPDATE SKIP LOCKED.
   */
  claimed?: PlatformJobItem;
  createArtifactWriteStream?: (tmpPath: string) => NodeJS.WritableStream;
  leaseMs?: number;
  /**
   * Test seam: override the defense-in-depth byte ceiling (production keeps 256 MiB).
   * Used to prove streaming handles artifacts larger than a small injected cap path.
   */
  maxArtifactBytes?: number;
  /**
   * Test seam (SAO-005): every model method call during RR materialisation
   * (real query-count proxy — catches reintroduced getTopic N+1).
   */
  onSnapshotModelCall?: (info: { method: string; model: string }) => void;
  /**
   * Test seam (SAO-005): observe each keyset page fetch during RR materialisation.
   */
  onSnapshotPageFetch?: (info: {
    kind: 'operation_logs' | 'conversations_topics' | 'conversations_messages' | 'user_timeline';
  }) => void;
  storage?: AuditExportArtifactStorage;
  workerId: string;
}

export interface ProcessNextAuditExportResult {
  claimed: boolean;
  exportId?: string;
  jobId?: string;
  outcome?: 'cancelled' | 'completed' | 'failed' | 'retry' | 'skipped';
}

export type { ExportTimeWindow } from './exportWorkerShared';

/**
 * Claim and process at most one audit export job.
 * Safe to call in a poller loop; returns claimed=false when the queue is empty.
 */
export const processNextAuditExportJob = async (
  db: LobeChatDatabase,
  options: ProcessNextAuditExportOptions,
): Promise<ProcessNextAuditExportResult> => {
  const jobs = new PlatformJobModel(db);
  const exportsModel = new PlatformAuditExportModel(db);
  const storage = options.storage ?? new AuditExportPrivateS3Storage();
  const leaseMs = options.leaseMs ?? AUDIT_EXPORT_DEFAULT_LEASE_MS;
  const maxArtifactBytes = options.maxArtifactBytes ?? AUDIT_EXPORT_MAX_ARTIFACT_BYTES;

  const claimed =
    options.claimed ??
    (await jobs.claimNext({
      leaseMs,
      types: [PLATFORM_AUDIT_EXPORT_JOB_TYPE],
      workerId: options.workerId,
    }));
  if (!claimed) return { claimed: false };

  const parsedInput = parseAuditExportJobInput(claimed.input);
  if (!parsedInput) {
    await jobs.fail({
      error: { code: 'INVALID_INPUT' },
      jobId: claimed.id,
      terminal: true,
      workerId: options.workerId,
    });
    return { claimed: true, jobId: claimed.id, outcome: 'failed' };
  }

  const exportId = parsedInput.exportId;
  // Fenced attempt identity — unique object key + complete() condition.
  const attemptToken = buildAuditExportAttemptToken(claimed.id, claimed.attempt);
  const storageKey = buildAuditExportAttemptStorageKey(exportId, attemptToken);

  try {
    const exportRow = await exportsModel.get(exportId);
    const nonRunnable = settleNonRunnableExport({
      db,
      exportId,
      exportRow,
      exportsModel,
      jobId: claimed.id,
      jobs,
      storage,
      workerId: options.workerId,
    });
    if (nonRunnable) return await nonRunnable;
    if (!exportRow) {
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'failed' };
    }

    // pending → running (or re-enter running after lease recovery / retry)
    if (exportRow.status === 'pending') {
      await exportsModel.markRunning(exportId, { jobId: claimed.id });
    }

    // Bind fencing token before any long work so concurrent reclaim cannot publish.
    const bound = await exportsModel.bindPublicationAttempt(exportId, attemptToken);
    if (!bound) {
      // Concurrent cancel/complete between read and bind.
      const current = await exportsModel.get(exportId);
      if (current?.status === 'cancelled') {
        await jobs.cancel(claimed.id);
        return { claimed: true, exportId, jobId: claimed.id, outcome: 'cancelled' };
      }
      throw new AuditExportLeaseLostError();
    }

    // Live policy only as fallback for legacy rows missing frozen caps.
    const livePolicy = await new PlatformAuditPolicyModel(db).getOrCreate();
    // Conversation surfaces: recheck kill-switch before reading evidence (F3).
    if (exportRow.kind === 'conversations' || exportRow.kind === 'user_timeline') {
      try {
        assertConversationAccessEnabled(livePolicy.contentAccessMode);
      } catch {
        await terminalFailExport(db, {
          code: 'CONTENT_ACCESS_DISABLED',
          exportId,
          jobId: claimed.id,
          requestedBy: exportRow.requestedBy,
          terminal: true,
          workerId: options.workerId,
        });
        return { claimed: true, exportId, jobId: claimed.id, outcome: 'failed' };
      }
    }
    const { exportArtifactRetentionDays, filter, maxExportRows, snapshotAt, snapshotWindow } =
      resolveExportExecutionPlan({
        filterSnapshot: exportRow.filterSnapshot,
        livePolicy,
      });

    return await runFencedExportPublication({
      afterArtifactUpload: options.afterArtifactUpload,
      afterDomainComplete: options.afterDomainComplete,
      attemptToken,
      createArtifactWriteStream: options.createArtifactWriteStream,
      db,
      exportArtifactRetentionDays,
      exportId,
      exportRow,
      exportsModel,
      filter,
      jobId: claimed.id,
      jobs,
      leaseMs,
      livePolicyRevision: livePolicy.revision,
      maxArtifactBytes,
      maxExportRows,
      onSnapshotModelCall: options.onSnapshotModelCall,
      onSnapshotPageFetch: options.onSnapshotPageFetch,
      snapshotAt,
      snapshotWindow,
      storage,
      storageKey,
      workerId: options.workerId,
    });
  } catch (error) {
    return settleExportJobFailure({
      db,
      error,
      exportId,
      exportsModel,
      jobId: claimed.id,
      storage,
      storageKey,
      workerId: options.workerId,
    });
  }
};

export const runAuditExportBatches = async (
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
    const result = await processNextAuditExportJob(db, {
      storage: params.storage,
      workerId: params.workerId,
    });
    if (!result.claimed) break;
    processed += 1;
  }
  return processed;
};

export type { PlatformAuditExportItem };

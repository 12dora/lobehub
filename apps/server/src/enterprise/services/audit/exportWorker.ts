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

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import {
  type PlatformAuditExportItem,
  PlatformAuditExportModel,
  PlatformAuditPolicyModel,
  PlatformJobModel,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import { assertConversationAccessEnabled } from './contentPolicy';
import {
  AUDIT_EXPORT_ARTIFACT_VERSION,
  AUDIT_EXPORT_DEFAULT_LEASE_MS,
  AUDIT_EXPORT_MAX_ARTIFACT_BYTES,
  parseAuditExportJobInput,
  PLATFORM_AUDIT_EXPORT_JOB_TYPE,
} from './exportConstants';
import {
  AUDIT_EXPORT_CONTENT_TYPE,
  type AuditExportArtifactStorage,
  AuditExportPrivateS3Storage,
  buildAuditExportAttemptStorageKey,
  buildAuditExportAttemptToken,
  checksumsMatch,
  formatArtifactChecksum,
} from './exportStorage';
import {
  AuditExportArtifactTooLargeError,
  AuditExportCancelledError,
  AuditExportInvalidFilterError,
  AuditExportLeaseLostError,
  AuditExportMaxRowsError,
  isTerminalContractError,
} from './exportWorkerErrors';
import type { ExportTimeWindow } from './exportWorkerShared';
import { jsonlLine, runWithPeriodicLeaseMaintenance, toIso } from './exportWorkerShared';
import { materializeExportSnapshot, streamStagingIntoArtifact } from './exportWorkerSnapshot';
import {
  safeDeleteOwned,
  terminalCancelExport,
  terminalCompleteExport,
  terminalFailExport,
} from './exportWorkerTerminal';
import { mapExportFailureCode } from './jobError';

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

/** Align with adminAuditPolicyUpdateInputSchema max bounds. */
const FROZEN_MAX_EXPORT_ROWS_BOUND = 1_000_000;
const FROZEN_EXPORT_ARTIFACT_RETENTION_DAYS_BOUND = 365;

/**
 * Require a valid ISO timestamp from the frozen snapshot.
 * Missing or invalid values terminal-fail — never silently widen the scan window.
 */
const parseRequiredIsoDate = (value: string | undefined, field: 'from' | 'to'): Date => {
  if (value == null || value === '') {
    throw new AuditExportInvalidFilterError(
      `${field} required in frozen filter snapshot for export`,
    );
  }
  if (typeof value !== 'string') {
    throw new AuditExportInvalidFilterError(`Invalid frozen ${field}: must be an ISO-8601 string`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new AuditExportInvalidFilterError(`Invalid frozen ${field}: ${value}`);
  }
  return d;
};

/**
 * Prefer frozen snapshot when present and valid; absent → live policy (legacy rows).
 * Present but non-positive / non-integer / over safe schema bounds → terminal fail.
 * Never silently coerce invalid caps into a fallback that widens the export.
 */
const resolveFrozenPositiveInt = (
  snapshot: number | undefined,
  live: number,
  bounds: { field: string; max: number },
): number => {
  if (snapshot === undefined) {
    return Math.max(1, Math.min(bounds.max, Math.floor(live)));
  }
  if (
    typeof snapshot !== 'number' ||
    !Number.isInteger(snapshot) ||
    snapshot < 1 ||
    snapshot > bounds.max
  ) {
    throw new AuditExportInvalidFilterError(
      `Invalid frozen ${bounds.field}: ${String(snapshot)} (expected integer 1..${bounds.max})`,
    );
  }
  return snapshot;
};

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

  const claimed = await jobs.claimNext({
    leaseMs,
    types: [PLATFORM_AUDIT_EXPORT_JOB_TYPE],
    workerId: options.workerId,
  });
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
    if (!exportRow) {
      await jobs.fail({
        error: { code: 'NOT_FOUND' },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'failed' };
    }

    if (exportRow.status === 'cancelled') {
      await terminalCancelExport(db, {
        exportId,
        jobId: claimed.id,
        requestedBy: exportRow.requestedBy,
        workerId: options.workerId,
      });
      // Only purge keys we know about from the cancelled row — never a winner's key.
      const knownKey =
        exportRow.storageKey ||
        (exportRow.error as { purgeStorageKey?: string } | null)?.purgeStorageKey ||
        null;
      if (knownKey) {
        await safeDeleteOwned(storage, knownKey, exportsModel, exportId);
      }
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'cancelled' };
    }

    if (exportRow.status === 'completed') {
      await jobs.complete({
        jobId: claimed.id,
        resultSummary: { exportId, rowCount: exportRow.rowCount ?? 0 },
        workerId: options.workerId,
      });
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'skipped' };
    }

    if (exportRow.status === 'failed' || exportRow.status === 'expired') {
      await jobs.fail({
        error: { code: 'EXPORT_TERMINAL' },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'skipped' };
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
    const filter = exportRow.filterSnapshot ?? {};
    // Time window is mandatory: invalid/missing from|to must never widen to full-table scan.
    const timeWindow: ExportTimeWindow = {
      from: parseRequiredIsoDate(filter.from, 'from'),
      to: parseRequiredIsoDate(filter.to, 'to'),
    };
    const maxExportRows = resolveFrozenPositiveInt(filter.maxExportRows, livePolicy.maxExportRows, {
      field: 'maxExportRows',
      max: FROZEN_MAX_EXPORT_ROWS_BOUND,
    });
    const exportArtifactRetentionDays = resolveFrozenPositiveInt(
      filter.exportArtifactRetentionDays,
      livePolicy.exportArtifactRetentionDays,
      {
        field: 'exportArtifactRetentionDays',
        max: FROZEN_EXPORT_ARTIFACT_RETENTION_DAYS_BOUND,
      },
    );
    // Point-in-time watermark: never include rows created after export execution starts.
    const snapshotAt = new Date();
    const snapshotWindow: ExportTimeWindow = {
      from: timeWindow.from,
      to: timeWindow.to.getTime() < snapshotAt.getTime() ? timeWindow.to : snapshotAt,
    };

    // Stream NDJSON to a temp file (bounded memory: one line / batch, not 1M rows).
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'audit-export-'));
    const tmpPath = path.join(tmpDir, 'evidence.ndjson');
    const stagingPath = path.join(tmpDir, 'snapshot.ndjson');
    let lineCount = 0;
    let totalBytes = 0;
    let evidenceCount = 0;
    const hasher = createHash('sha256');
    const fileStream = (
      options.createArtifactWriteStream
        ? options.createArtifactWriteStream(tmpPath)
        : createWriteStream(tmpPath, { flags: 'w' })
    ) as WriteStream;
    // SAO-006: record stream errors immediately — never rethrow into an unhandled
    // rejection while the worker awaits materialization / other macrotasks.
    // Premature close from intentional destroy() in finally is expected.
    let fileClosedIntentionally = false;
    let streamError: Error | null = null;
    const fileFinished = finished(fileStream).catch((err: NodeJS.ErrnoException) => {
      if (fileClosedIntentionally && err?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      streamError = err instanceof Error ? err : new Error(String(err));
    });

    const writeLine = async (line: string) => {
      if (streamError) throw streamError;
      const buf = Buffer.from(line, 'utf8');
      hasher.update(buf);
      totalBytes += buf.byteLength;
      if (totalBytes > maxArtifactBytes) {
        throw new AuditExportArtifactTooLargeError();
      }
      lineCount += 1;
      const ok = fileStream.write(buf);
      if (!ok) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            fileStream.off('error', onError);
            resolve();
          };
          const onError = (err: Error) => {
            fileStream.off('drain', onDrain);
            reject(err);
          };
          fileStream.once('drain', onDrain);
          fileStream.once('error', onError);
        });
      }
      if (streamError) throw streamError;
    };

    const assertNotCancelled = async () => {
      const current = await exportsModel.get(exportId);
      if (!current || current.status === 'cancelled') {
        throw new AuditExportCancelledError();
      }
      // Fencing: if another attempt rebound the token, stop without cancelling.
      const boundToken = (current.error as { attemptToken?: string } | null)?.attemptToken;
      if (boundToken && boundToken !== attemptToken) {
        throw new AuditExportLeaseLostError();
      }
      const job = await jobs.findById(claimed.id);
      if (!job || job.status === 'cancelled') {
        throw new AuditExportCancelledError();
      }
      // Renew lease + progress — null means lease loss, NOT user cancellation.
      const cp = await jobs.checkpoint({
        jobId: claimed.id,
        leaseMs,
        progressDone: Math.max(0, lineCount - 1),
        workerId: options.workerId,
      });
      if (!cp) {
        throw new AuditExportLeaseLostError();
      }
    };

    let completedRow: Awaited<ReturnType<PlatformAuditExportModel['complete']>> | null = null;
    const requestedBy = exportRow.requestedBy;

    try {
      await assertNotCancelled();

      await writeLine(
        jsonlLine({
          createdAt: toIso(exportRow.createdAt),
          exportArtifactRetentionDays,
          exportId,
          filterSnapshot: filter,
          includesMessageBodies: exportRow.includesMessageBodies,
          kind: exportRow.kind,
          maxExportRows,
          policyRevision: filter.policyRevision ?? livePolicy.revision,
          snapshotAt: toIso(snapshotAt),
          type: 'manifest',
          version: AUDIT_EXPORT_ARTIFACT_VERSION,
        }),
      );

      // Phase 1: materialise immutable evidence under one RR snapshot. The lease
      // maintainer uses the outer pool while the snapshot transaction owns another
      // connection, preventing a long scan from becoming reclaimable.
      const snapshot = await runWithPeriodicLeaseMaintenance(
        () =>
          materializeExportSnapshot(db, {
            filter,
            includeBodies: exportRow.includesMessageBodies,
            kind: exportRow.kind,
            maxExportRows,
            maxStagingBytes: Math.max(0, maxArtifactBytes - totalBytes),
            onModelCall: options.onSnapshotModelCall,
            onPageFetch: options.onSnapshotPageFetch,
            stagingPath,
            window: snapshotWindow,
          }),
        assertNotCancelled,
        Math.max(1, Math.floor(leaseMs / 3)),
      );
      evidenceCount = snapshot.evidenceCount;

      await assertNotCancelled();

      // Phase 2: stream frozen staging lines into the artifact with heartbeats
      // and batched copy (SAO-005 — no live N+1 re-reads).
      await streamStagingIntoArtifact(stagingPath, writeLine, assertNotCancelled);

      await assertNotCancelled();
      if (streamError) throw streamError;
      fileStream.end();
      await fileFinished;
      if (streamError) throw streamError;

      // Incremental digest from the write path — never re-buffer the temp file (F10).
      const localChecksum = formatArtifactChecksum(hasher.digest('hex'));

      // Renew lease before long remote I/O (upload / metadata / hash) — SAO-002.
      await assertNotCancelled();

      // F6: durable cleanup intent for THIS attempt key only, fenced by attemptToken.
      const intentOk = await exportsModel.recordArtifactUploadIntent(exportId, storageKey, db, {
        attemptToken,
      });
      if (!intentOk) {
        throw new AuditExportLeaseLostError();
      }

      await assertNotCancelled();
      const uploaded = await storage.uploadArtifact({
        artifactChecksum: localChecksum,
        body: createReadStream(tmpPath),
        contentLength: totalBytes,
        contentType: AUDIT_EXPORT_CONTENT_TYPE,
        storageKey,
      });
      await assertNotCancelled();

      // Integrity: size + streaming SHA-256 — same-length corruption must fail closed.
      if (!checksumsMatch(uploaded.artifactChecksum, localChecksum)) {
        await safeDeleteOwned(storage, storageKey);
        throw new Error('AUDIT_EXPORT_CHECKSUM_MISMATCH');
      }
      if (uploaded.artifactBytes !== totalBytes) {
        await safeDeleteOwned(storage, storageKey);
        throw new Error('AUDIT_EXPORT_SIZE_MISMATCH');
      }
      await assertNotCancelled();
      const meta = await storage.getObjectMetadata(storageKey);
      if (meta.contentLength !== uploaded.artifactBytes || meta.contentLength !== totalBytes) {
        await safeDeleteOwned(storage, storageKey);
        throw new Error('AUDIT_EXPORT_SIZE_MISMATCH');
      }
      await assertNotCancelled();
      const storedHash = await storage.hashObject(storageKey);
      if (
        storedHash.artifactBytes !== totalBytes ||
        !checksumsMatch(storedHash.artifactChecksum, uploaded.artifactChecksum)
      ) {
        await safeDeleteOwned(storage, storageKey);
        throw new Error('AUDIT_EXPORT_CHECKSUM_MISMATCH');
      }

      if (options.afterArtifactUpload) {
        await options.afterArtifactUpload({
          exportId,
          jobId: claimed.id,
          storageKey: uploaded.storageKey,
        });
      }

      await assertNotCancelled();

      const expiresAt = new Date(
        Date.now() + Math.max(1, exportArtifactRetentionDays) * 24 * 60 * 60 * 1000,
      );

      // Fenced transactional publication + required audit (SAO-002 / SAO-004).
      completedRow = await terminalCompleteExport(db, {
        afterDomainComplete: options.afterDomainComplete
          ? async () => {
              await options.afterDomainComplete!({ exportId, jobId: claimed.id });
            }
          : undefined,
        artifactBytes: uploaded.artifactBytes,
        artifactChecksum: uploaded.artifactChecksum,
        attemptToken,
        evidenceCount,
        exportId,
        expiresAt,
        jobId: claimed.id,
        requestedBy,
        storageKey: uploaded.storageKey,
        workerId: options.workerId,
      });
    } finally {
      fileClosedIntentionally = true;
      if (!fileStream.destroyed) {
        fileStream.destroy();
      }
      await fileFinished.catch(() => undefined);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }

    if (!completedRow) {
      // Lost race: cancel or another fenced attempt won. Never purge a completed
      // row's published key — only delete our attempt-unique object (SAO-002).
      const current = await exportsModel.get(exportId);
      if (current?.status === 'completed') {
        if (current.storageKey !== storageKey) {
          await safeDeleteOwned(storage, storageKey);
        }
        await jobs.cancel(claimed.id);
        return { claimed: true, exportId, jobId: claimed.id, outcome: 'cancelled' };
      }
      await safeDeleteOwned(storage, storageKey, exportsModel, exportId);
      await jobs.cancel(claimed.id);
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'cancelled' };
    }

    return { claimed: true, exportId, jobId: claimed.id, outcome: 'completed' };
  } catch (error) {
    if (error instanceof AuditExportLeaseLostError) {
      // Lease loss is NOT user cancellation — leave domain + platform job as-is for reclaim.
      // Best-effort delete of our attempt key only (never the published winner).
      await safeDeleteOwned(storage, storageKey);
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'skipped' };
    }

    if (error instanceof AuditExportCancelledError) {
      const exportRow = await exportsModel.get(exportId);
      await terminalCancelExport(db, {
        exportId,
        jobId: claimed.id,
        requestedBy: exportRow?.requestedBy ?? 'system',
        workerId: options.workerId,
      });
      await safeDeleteOwned(storage, storageKey, exportsModel, exportId);
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'cancelled' };
    }

    // Bounded enum only — never Error.name / free-form message as public code (F3).
    const code = isTerminalContractError(error)
      ? error instanceof AuditExportMaxRowsError
        ? 'MAX_EXPORT_ROWS_EXCEEDED'
        : error instanceof AuditExportInvalidFilterError
          ? 'INVALID_FILTER_SNAPSHOT'
          : error instanceof AuditExportArtifactTooLargeError
            ? 'ARTIFACT_TOO_LARGE'
            : mapExportFailureCode(error)
      : mapExportFailureCode(error);

    const exportRow = await exportsModel.get(exportId);
    const requestedBy = exportRow?.requestedBy ?? 'system';

    if (isTerminalContractError(error)) {
      await terminalFailExport(db, {
        code,
        exportId,
        jobId: claimed.id,
        requestedBy,
        terminal: true,
        workerId: options.workerId,
      });
      await safeDeleteOwned(storage, storageKey, exportsModel, exportId);
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'failed' };
    }

    // Transient / unknown: atomically requeue, or terminalize domain/job/audit
    // together when this attempt exhausts the budget.
    await safeDeleteOwned(storage, storageKey);
    const terminal = await terminalFailExport(db, {
      code,
      exportId,
      jobId: claimed.id,
      requestedBy,
      terminal: false,
      workerId: options.workerId,
    });

    if (terminal) {
      await safeDeleteOwned(storage, storageKey, exportsModel, exportId);
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'failed' };
    }

    return { claimed: true, exportId, jobId: claimed.id, outcome: 'retry' };
  }
};

/** Required append-only worker outcome (SAO-004). Fail closed when required. */
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

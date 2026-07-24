/**
 * Functional worker for platform.audit.export.v1 jobs.
 * Keyset-batched DB reads, lease renewal, cancellation checks.
 * Builds NDJSON (manifest + evidence). Hard-fails if maxExportRows+1 would be written.
 * No generic redaction / summarization / body truncation; credential-only masking for messages.
 *
 * Evidence inventory is frozen under a PostgreSQL REPEATABLE READ snapshot (plus an
 * export-start watermark on `to`) so concurrent inserts/updates/deletes cannot reshape
 * the eligible ID set mid-export. Full rows are then streamed by frozen ID batches with
 * heartbeats outside the snapshot TX (avoids single-connection deadlocks). NDJSON lines
 * stream to a temp file with incremental SHA-256 — O(batch) memory during write, not a
 * million-element in-memory line buffer.
 *
 * Reliability: unknown/transient storage/DB errors requeue via platform_jobs (maxAttempts);
 * domain stays `running` and the deterministic object is cleaned. Domain is marked failed
 * only when the job becomes `dead`. Contract/data errors (max rows, invalid frozen filter)
 * are terminal immediately.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { sql } from 'drizzle-orm';

import {
  maskAuditConversationEvidence,
  PlatformAuditConversationModel,
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportItem,
  PlatformAuditExportModel,
  PlatformAuditLogModel,
  PlatformAuditPolicyModel,
  PlatformJobModel,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  AUDIT_EXPORT_ARTIFACT_VERSION,
  AUDIT_EXPORT_BATCH_LIMIT,
  AUDIT_EXPORT_DEFAULT_LEASE_MS,
  parseAuditExportJobInput,
  PLATFORM_AUDIT_EXPORT_JOB_TYPE,
} from './exportConstants';
import {
  AUDIT_EXPORT_CONTENT_TYPE,
  type AuditExportArtifactStorage,
  AuditExportPrivateS3Storage,
  buildAuditExportStorageKey,
  formatArtifactChecksum,
  sha256Hex,
} from './exportStorage';

export interface ProcessNextAuditExportOptions {
  /**
   * Test seam: after domain `complete` succeeds, before `jobs.complete`.
   * Used to simulate final-step lease loss without cancelling the domain.
   */
  afterDomainComplete?: (info: { exportId: string; jobId: string }) => Promise<void> | void;
  leaseMs?: number;
  storage?: AuditExportArtifactStorage;
  workerId: string;
}

export interface ProcessNextAuditExportResult {
  claimed: boolean;
  exportId?: string;
  jobId?: string;
  outcome?: 'cancelled' | 'completed' | 'failed' | 'retry' | 'skipped';
}

/** Explicit domain/job cancellation only — never lease loss. */
class AuditExportCancelledError extends Error {
  constructor() {
    super('AUDIT_EXPORT_CANCELLED');
    this.name = 'AuditExportCancelledError';
  }
}

/** Checkpoint returned null / lease owner changed — do not cancel domain or job. */
export class AuditExportLeaseLostError extends Error {
  constructor() {
    super('AUDIT_EXPORT_LEASE_LOST');
    this.name = 'AuditExportLeaseLostError';
  }
}

/** Terminal contract error: export exceeds frozen maxExportRows. */
class AuditExportMaxRowsError extends Error {
  constructor(public readonly maxExportRows: number) {
    super('AUDIT_EXPORT_MAX_ROWS_EXCEEDED');
    this.name = 'AuditExportMaxRowsError';
  }
}

/** Terminal contract error: frozen filter snapshot is invalid for the export kind. */
class AuditExportInvalidFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditExportInvalidFilterError';
  }
}

const isTerminalContractError = (error: unknown): boolean =>
  error instanceof AuditExportMaxRowsError || error instanceof AuditExportInvalidFilterError;

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

type ExportTimeWindow = { from: Date; to: Date };

const jsonlLine = (row: Record<string, unknown>): string => `${JSON.stringify(row)}\n`;

const toIso = (value: Date | string | null | undefined): string | null => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

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

  const claimed = await jobs.claimNext({
    leaseMs,
    types: [PLATFORM_AUDIT_EXPORT_JOB_TYPE],
    workerId: options.workerId,
  });
  if (!claimed) return { claimed: false };

  const parsedInput = parseAuditExportJobInput(claimed.input);
  if (!parsedInput) {
    await jobs.fail({
      error: { code: 'INVALID_INPUT', message: 'exportId missing from job input' },
      jobId: claimed.id,
      terminal: true,
      workerId: options.workerId,
    });
    return { claimed: true, jobId: claimed.id, outcome: 'failed' };
  }

  const exportId = parsedInput.exportId;
  const storageKey = buildAuditExportStorageKey(exportId);

  try {
    const exportRow = await exportsModel.get(exportId);
    if (!exportRow) {
      await jobs.fail({
        error: { code: 'NOT_FOUND', message: 'export row missing' },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'failed' };
    }

    if (exportRow.status === 'cancelled') {
      await jobs.cancel(claimed.id);
      await safeDelete(storage, storageKey);
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
        error: { code: 'EXPORT_TERMINAL', message: `export already ${exportRow.status}` },
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

    // Live policy only as fallback for legacy rows missing frozen caps.
    const livePolicy = await new PlatformAuditPolicyModel(db).getOrCreate();
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
    let lineCount = 0;
    let totalBytes = 0;
    let evidenceCount = 0;
    const hasher = createHash('sha256');
    const fileStream = createWriteStream(tmpPath, { flags: 'w' });

    const writeLine = async (line: string) => {
      const buf = Buffer.from(line, 'utf8');
      hasher.update(buf);
      totalBytes += buf.byteLength;
      lineCount += 1;
      if (!fileStream.write(buf)) {
        await new Promise<void>((resolve, reject) => {
          fileStream.once('drain', () => resolve());
          fileStream.once('error', reject);
        });
      }
    };

    const assertNotCancelled = async () => {
      const current = await exportsModel.get(exportId);
      if (!current || current.status === 'cancelled') {
        throw new AuditExportCancelledError();
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
    let uploadedBytes = 0;

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

      const pushEvidence = async (row: Record<string, unknown>) => {
        evidenceCount += 1;
        if (evidenceCount > maxExportRows) {
          throw new AuditExportMaxRowsError(maxExportRows);
        }
        await writeLine(jsonlLine(row));
      };

      // Phase 1: freeze eligible IDs under one RR snapshot (no outer-db heartbeats —
      // single-connection test DBs deadlock if lease checks run while the TX holds
      // the only connection). Phase 2 streams full rows by frozen ID with heartbeats.
      const inventory = await freezeExportInventory(db, {
        filter,
        includeBodies: exportRow.includesMessageBodies,
        kind: exportRow.kind,
        maxExportRows,
        window: snapshotWindow,
      });

      await assertNotCancelled();

      if (inventory.kind === 'operation_logs') {
        await streamOperationLogsByIds(db, inventory.ids, pushEvidence, assertNotCancelled);
      } else if (inventory.kind === 'conversations') {
        await streamConversationsByInventory(db, inventory, pushEvidence, assertNotCancelled);
      } else {
        await streamUserTimelineByIds(
          db,
          inventory.userId,
          inventory.ids,
          pushEvidence,
          assertNotCancelled,
        );
      }

      await assertNotCancelled();
      fileStream.end();
      await finished(fileStream);

      // Single final read for upload (collection itself never held all rows in RAM).
      const body = await readFile(tmpPath);
      const localChecksum = formatArtifactChecksum(hasher.digest('hex'));
      if (body.byteLength !== totalBytes) {
        throw new Error('AUDIT_EXPORT_TEMP_SIZE_MISMATCH');
      }

      const uploaded = await storage.uploadArtifact({
        body,
        contentType: AUDIT_EXPORT_CONTENT_TYPE,
        storageKey,
      });
      uploadedBytes = uploaded.artifactBytes;

      // Integrity: size + SHA-256 — same-length corruption must fail closed (clean + retry).
      if (uploaded.artifactChecksum !== localChecksum) {
        await safeDelete(storage, storageKey);
        throw new Error('AUDIT_EXPORT_CHECKSUM_MISMATCH');
      }
      const meta = await storage.getObjectMetadata(storageKey);
      if (meta.contentLength !== uploaded.artifactBytes || meta.contentLength !== totalBytes) {
        await safeDelete(storage, storageKey);
        throw new Error('AUDIT_EXPORT_SIZE_MISMATCH');
      }
      const storedBytes = await storage.getObjectBytes(storageKey);
      if (formatArtifactChecksum(sha256Hex(storedBytes)) !== uploaded.artifactChecksum) {
        await safeDelete(storage, storageKey);
        throw new Error('AUDIT_EXPORT_CHECKSUM_MISMATCH');
      }

      const expiresAt = new Date(
        Date.now() + Math.max(1, exportArtifactRetentionDays) * 24 * 60 * 60 * 1000,
      );

      completedRow = await exportsModel.complete(exportId, {
        artifactBytes: uploaded.artifactBytes,
        artifactChecksum: uploaded.artifactChecksum,
        expiresAt,
        rowCount: evidenceCount,
        storageKey: uploaded.storageKey,
      });
    } finally {
      fileStream.destroy();
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }

    if (!completedRow) {
      // Race with cancel — clean object
      await safeDelete(storage, storageKey);
      await jobs.cancel(claimed.id);
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'cancelled' };
    }

    if (options.afterDomainComplete) {
      await options.afterDomainComplete({ exportId, jobId: claimed.id });
    }

    const jobDone = await jobs.complete({
      jobId: claimed.id,
      resultSummary: {
        artifactBytes: uploadedBytes,
        exportId,
        rowCount: evidenceCount,
      },
      workerId: options.workerId,
    });
    if (!jobDone) {
      // Domain already terminal-completed; lease ownership lost — do not report clean
      // completion, cancel, or delete the object (reclaiming owner finishes platform job).
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'skipped' };
    }

    return { claimed: true, exportId, jobId: claimed.id, outcome: 'completed' };
  } catch (error) {
    if (error instanceof AuditExportLeaseLostError) {
      // Lease loss is NOT user cancellation — leave domain + platform job as-is for reclaim.
      // Do not touch storage: a reclaiming worker uses the same deterministic key.
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'skipped' };
    }

    if (error instanceof AuditExportCancelledError) {
      await exportsModel.cancel(exportId);
      await jobs.cancel(claimed.id);
      await safeDelete(storage, storageKey);
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'cancelled' };
    }

    const code =
      error instanceof AuditExportMaxRowsError
        ? 'MAX_EXPORT_ROWS_EXCEEDED'
        : error instanceof AuditExportInvalidFilterError
          ? 'INVALID_FILTER_SNAPSHOT'
          : error instanceof Error
            ? error.name || 'EXPORT_FAILED'
            : 'EXPORT_FAILED';
    const message =
      error instanceof AuditExportMaxRowsError
        ? `Export exceeds maxExportRows (${error.maxExportRows}); no partial artifact retained`
        : error instanceof Error
          ? error.message.slice(0, 500)
          : 'export failed';

    // Always clean the deterministic object before fail/retry so retries start clean.
    await safeDelete(storage, storageKey);

    if (isTerminalContractError(error)) {
      await exportsModel.fail(exportId, { code, message });
      await jobs.fail({
        error: { code, message },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'failed' };
    }

    // Transient / unknown: requeue job (or dead when maxAttempts exhausted).
    // Keep domain `running` while the job can still retry.
    const failedJob = await jobs.fail({
      error: { code, message },
      jobId: claimed.id,
      workerId: options.workerId,
    });

    if (failedJob?.status === 'dead') {
      await exportsModel.fail(exportId, { code, message });
      return { claimed: true, exportId, jobId: claimed.id, outcome: 'failed' };
    }

    return { claimed: true, exportId, jobId: claimed.id, outcome: 'retry' };
  }
};

const safeDelete = async (
  storage: AuditExportArtifactStorage,
  storageKey: string,
): Promise<void> => {
  try {
    await storage.deleteObject(storageKey);
  } catch {
    // best-effort cleanup
  }
};

type EvidencePush = (row: Record<string, unknown>) => void | Promise<void>;

type FrozenOpLogInventory = { kind: 'operation_logs'; ids: string[] };
type FrozenConversationInventory = {
  includeBodies: boolean;
  kind: 'conversations';
  topics: Array<{ id: string; messageIds: string[] }>;
  userId: string;
};
type FrozenTimelineInventory = { kind: 'user_timeline'; ids: string[]; userId: string };
type FrozenExportInventory =
  FrozenOpLogInventory | FrozenConversationInventory | FrozenTimelineInventory;

/**
 * Materialize eligible evidence IDs under one REPEATABLE READ snapshot.
 * Heartbeats must NOT run against the outer connection while this TX is open
 * (single-connection engines like PGlite would deadlock).
 */
const freezeExportInventory = async (
  db: LobeChatDatabase,
  params: {
    filter: PlatformAuditExportFilterSnapshot;
    includeBodies: boolean;
    kind: PlatformAuditExportItem['kind'];
    maxExportRows: number;
    window: ExportTimeWindow;
  },
): Promise<FrozenExportInventory> => {
  return db.transaction(async (tx) => {
    // First statement after BEGIN — required for SET TRANSACTION.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const snap = tx as unknown as LobeChatDatabase;

    if (params.kind === 'operation_logs') {
      const model = new PlatformAuditLogModel(snap);
      const ids: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await model.list({
          action: params.filter.action,
          actions: params.filter.actions,
          actorUserId: params.filter.actorUserId,
          cursor,
          from: params.window.from,
          limit: AUDIT_EXPORT_BATCH_LIMIT,
          requestId: params.filter.requestId,
          result: params.filter.result,
          results: params.filter.results,
          targetId: params.filter.targetId,
          targetType: params.filter.targetType,
          to: params.window.to,
        });
        for (const row of page.items) {
          ids.push(row.id);
          if (ids.length > params.maxExportRows) {
            throw new AuditExportMaxRowsError(params.maxExportRows);
          }
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return { kind: 'operation_logs', ids };
    }

    if (params.kind === 'conversations') {
      const userId = params.filter.userId;
      if (!userId) {
        throw new AuditExportInvalidFilterError(
          'userId required in frozen filter for conversations export',
        );
      }
      const model = new PlatformAuditConversationModel(snap);
      const topics: FrozenConversationInventory['topics'] = [];
      let evidenceRows = 0;
      let topicCursor: string | undefined;

      for (;;) {
        const topicPage = await model.listTopics({
          cursor: topicCursor,
          from: params.window.from,
          limit: AUDIT_EXPORT_BATCH_LIMIT,
          q: params.filter.q,
          to: params.window.to,
          userId,
        });

        for (const topic of topicPage.items) {
          if (params.filter.topicId && topic.id !== params.filter.topicId) continue;
          evidenceRows += 1;
          if (evidenceRows > params.maxExportRows) {
            throw new AuditExportMaxRowsError(params.maxExportRows);
          }

          const messageIds: string[] = [];
          if (params.includeBodies) {
            let msgCursor: string | undefined;
            for (;;) {
              // Metadata list only — freeze IDs, not bodies, under the snapshot.
              const msgPage = await model.listMessages({
                cursor: msgCursor,
                from: params.window.from,
                limit: AUDIT_EXPORT_BATCH_LIMIT,
                to: params.window.to,
                topicId: topic.id,
                userId,
              });
              for (const msg of msgPage.items) {
                messageIds.push(msg.id);
                evidenceRows += 1;
                if (evidenceRows > params.maxExportRows) {
                  throw new AuditExportMaxRowsError(params.maxExportRows);
                }
              }
              if (!msgPage.nextCursor) break;
              msgCursor = msgPage.nextCursor;
            }
          }
          topics.push({ id: topic.id, messageIds });
        }

        if (!topicPage.nextCursor) break;
        topicCursor = topicPage.nextCursor;
      }

      return { includeBodies: params.includeBodies, kind: 'conversations', topics, userId };
    }

    // user_timeline
    const userId = params.filter.userId;
    if (!userId) {
      throw new AuditExportInvalidFilterError(
        'userId required in frozen filter for user_timeline export',
      );
    }
    const model = new PlatformAuditConversationModel(snap);
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await model.listUserTimeline({
        cursor,
        from: params.window.from,
        limit: AUDIT_EXPORT_BATCH_LIMIT,
        to: params.window.to,
        userId,
      });
      for (const item of page.items) {
        ids.push(item.id);
        if (ids.length > params.maxExportRows) {
          throw new AuditExportMaxRowsError(params.maxExportRows);
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return { kind: 'user_timeline', ids, userId };
  });
};

const streamOperationLogsByIds = async (
  db: LobeChatDatabase,
  ids: string[],
  push: EvidencePush,
  heartbeat: () => Promise<void>,
): Promise<void> => {
  const model = new PlatformAuditLogModel(db);
  for (let i = 0; i < ids.length; i += AUDIT_EXPORT_BATCH_LIMIT) {
    await heartbeat();
    const batch = ids.slice(i, i + AUDIT_EXPORT_BATCH_LIMIT);
    for (const id of batch) {
      const row = await model.findById(id);
      if (!row) continue; // deleted after snapshot — omit rather than fail the package
      await push({
        action: row.action,
        actorUserId: row.actorUserId,
        afterDiff: row.afterDiff,
        beforeDiff: row.beforeDiff,
        configRevision: row.configRevision,
        createdAt: toIso(row.createdAt),
        id: row.id,
        ipHash: row.ipHash,
        reason: row.reason,
        requestId: row.requestId,
        result: row.result,
        targetId: row.targetId,
        targetType: row.targetType,
        type: 'operation_log',
        userAgent: row.userAgent,
      });
    }
  }
};

const streamConversationsByInventory = async (
  db: LobeChatDatabase,
  inventory: FrozenConversationInventory,
  push: EvidencePush,
  heartbeat: () => Promise<void>,
): Promise<void> => {
  const model = new PlatformAuditConversationModel(db);
  for (const topicRef of inventory.topics) {
    await heartbeat();
    const topic = await model.getTopic({ topicId: topicRef.id, userId: inventory.userId });
    if (!topic) continue;

    await push({
      agentId: topic.agentId,
      createdAt: toIso(topic.createdAt),
      description:
        topic.description == null ? null : maskAuditConversationEvidence(topic.description),
      id: topic.id,
      model: topic.model,
      provider: topic.provider,
      sessionId: topic.sessionId,
      status: topic.status,
      title: topic.title == null ? null : maskAuditConversationEvidence(topic.title),
      type: 'conversation_topic',
      updatedAt: toIso(topic.updatedAt),
      userId: topic.userId,
    });

    if (!inventory.includeBodies) continue;

    for (let i = 0; i < topicRef.messageIds.length; i += AUDIT_EXPORT_BATCH_LIMIT) {
      await heartbeat();
      const batch = topicRef.messageIds.slice(i, i + AUDIT_EXPORT_BATCH_LIMIT);
      for (const messageId of batch) {
        const msg = await model.getMessage({ messageId, userId: inventory.userId });
        if (!msg) continue;
        await push({
          agentId: msg.agentId,
          content: msg.content == null ? null : maskAuditConversationEvidence(msg.content),
          createdAt: toIso(msg.createdAt),
          editorData: msg.editorData == null ? null : maskAuditConversationEvidence(msg.editorData),
          error: msg.error == null ? null : maskAuditConversationEvidence(msg.error),
          id: msg.id,
          model: msg.model,
          parentId: msg.parentId,
          provider: msg.provider,
          role: msg.role,
          sessionId: msg.sessionId,
          topicId: msg.topicId,
          type: 'conversation_message',
          updatedAt: toIso(msg.updatedAt),
          userId: msg.userId,
        });
      }
    }
  }
};

const streamUserTimelineByIds = async (
  db: LobeChatDatabase,
  userId: string,
  ids: string[],
  push: EvidencePush,
  heartbeat: () => Promise<void>,
): Promise<void> => {
  // Timeline rows are projected from topics/sessions; re-scan and emit only frozen IDs.
  const model = new PlatformAuditConversationModel(db);
  const wanted = new Set(ids);
  let cursor: string | undefined;
  let emitted = 0;

  // Prefer topic get for topic-kind items; fall back to ordered re-scan filter.
  for (const id of ids) {
    await heartbeat();
    const topic = await model.getTopic({ topicId: id, userId });
    if (topic) {
      await push({
        createdAt: toIso(topic.createdAt),
        id: topic.id,
        kind: 'topic',
        sessionId: topic.sessionId,
        title: topic.title == null ? null : maskAuditConversationEvidence(topic.title),
        topicId: topic.id,
        type: 'user_timeline_item',
        updatedAt: toIso(topic.updatedAt),
        userId,
      });
      emitted += 1;
      wanted.delete(id);
    }
  }

  // Remaining IDs (sessions / other kinds) via listUserTimeline filter.
  if (wanted.size === 0) return;

  cursor = undefined;
  for (;;) {
    await heartbeat();
    const page = await model.listUserTimeline({
      cursor,
      limit: AUDIT_EXPORT_BATCH_LIMIT,
      userId,
    });
    for (const item of page.items) {
      if (!wanted.has(item.id)) continue;
      await push({
        createdAt: toIso(item.createdAt),
        id: item.id,
        kind: item.kind,
        sessionId: item.sessionId,
        title: item.title == null ? null : maskAuditConversationEvidence(item.title),
        topicId: item.topicId,
        type: 'user_timeline_item',
        updatedAt: toIso(item.updatedAt),
        userId,
      });
      emitted += 1;
      wanted.delete(item.id);
    }
    if (!page.nextCursor || wanted.size === 0) break;
    cursor = page.nextCursor;
  }

  void emitted;
};

/** Process up to `batchLimit` jobs (for poller / tests). */
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

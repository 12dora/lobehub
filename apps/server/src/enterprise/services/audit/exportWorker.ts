/**
 * Functional worker for platform.audit.export.v1 jobs.
 * Keyset-batched DB reads, lease renewal, cancellation checks.
 * Builds NDJSON (manifest + evidence). Hard-fails if maxExportRows+1 would be written.
 * No generic redaction / summarization / body truncation; credential-only masking for messages.
 *
 * Reliability: unknown/transient storage/DB errors requeue via platform_jobs (maxAttempts);
 * domain stays `running` and the deterministic object is cleaned. Domain is marked failed
 * only when the job becomes `dead`. Contract/data errors (max rows, invalid frozen filter)
 * are terminal immediately.
 */

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
    const lines: string[] = [];

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
        progressDone: lines.length > 0 ? lines.length - 1 : 0,
        workerId: options.workerId,
      });
      if (!cp) {
        throw new AuditExportLeaseLostError();
      }
    };

    await assertNotCancelled();

    lines.push(
      jsonlLine({
        createdAt: toIso(exportRow.createdAt),
        exportArtifactRetentionDays,
        exportId,
        filterSnapshot: filter,
        includesMessageBodies: exportRow.includesMessageBodies,
        kind: exportRow.kind,
        maxExportRows,
        policyRevision: filter.policyRevision ?? livePolicy.revision,
        type: 'manifest',
        version: AUDIT_EXPORT_ARTIFACT_VERSION,
      }),
    );

    let evidenceCount = 0;
    const pushEvidence = (row: Record<string, unknown>) => {
      evidenceCount += 1;
      if (evidenceCount > maxExportRows) {
        throw new AuditExportMaxRowsError(maxExportRows);
      }
      lines.push(jsonlLine(row));
    };

    if (exportRow.kind === 'operation_logs') {
      await collectOperationLogs(db, filter, timeWindow, pushEvidence, assertNotCancelled);
    } else if (exportRow.kind === 'conversations') {
      await collectConversations(
        db,
        filter,
        timeWindow,
        exportRow.includesMessageBodies,
        pushEvidence,
        assertNotCancelled,
      );
    } else if (exportRow.kind === 'user_timeline') {
      await collectUserTimeline(db, filter, timeWindow, pushEvidence, assertNotCancelled);
    }

    await assertNotCancelled();

    const body = Buffer.from(lines.join(''), 'utf8');
    const uploaded = await storage.uploadArtifact({
      body,
      contentType: AUDIT_EXPORT_CONTENT_TYPE,
      storageKey,
    });

    // Object metadata check (size) — mismatch treated as transient (clean + retry)
    const meta = await storage.getObjectMetadata(storageKey);
    if (meta.contentLength !== uploaded.artifactBytes) {
      await safeDelete(storage, storageKey);
      throw new Error('AUDIT_EXPORT_SIZE_MISMATCH');
    }

    const expiresAt = new Date(
      Date.now() + Math.max(1, exportArtifactRetentionDays) * 24 * 60 * 60 * 1000,
    );

    const completed = await exportsModel.complete(exportId, {
      artifactBytes: uploaded.artifactBytes,
      artifactChecksum: uploaded.artifactChecksum,
      expiresAt,
      rowCount: evidenceCount,
      storageKey: uploaded.storageKey,
    });

    if (!completed) {
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
        artifactBytes: uploaded.artifactBytes,
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

const collectOperationLogs = async (
  db: LobeChatDatabase,
  filter: PlatformAuditExportFilterSnapshot,
  window: ExportTimeWindow,
  push: (row: Record<string, unknown>) => void,
  heartbeat: () => Promise<void>,
): Promise<void> => {
  const model = new PlatformAuditLogModel(db);
  let cursor: string | undefined;
  for (;;) {
    await heartbeat();
    const page = await model.list({
      action: filter.action,
      actions: filter.actions,
      actorUserId: filter.actorUserId,
      cursor,
      from: window.from,
      limit: AUDIT_EXPORT_BATCH_LIMIT,
      requestId: filter.requestId,
      result: filter.result,
      results: filter.results,
      targetId: filter.targetId,
      targetType: filter.targetType,
      to: window.to,
    });

    for (const row of page.items) {
      // Preserve stored before/after diffs exactly (write-time redaction only).
      push({
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

    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
};

const collectConversations = async (
  db: LobeChatDatabase,
  filter: PlatformAuditExportFilterSnapshot,
  window: ExportTimeWindow,
  includeBodies: boolean,
  push: (row: Record<string, unknown>) => void,
  heartbeat: () => Promise<void>,
): Promise<void> => {
  const userId = filter.userId;
  if (!userId) {
    throw new AuditExportInvalidFilterError(
      'userId required in frozen filter for conversations export',
    );
  }

  const model = new PlatformAuditConversationModel(db);
  let topicCursor: string | undefined;

  for (;;) {
    await heartbeat();
    const topics = await model.listTopics({
      cursor: topicCursor,
      from: window.from,
      limit: AUDIT_EXPORT_BATCH_LIMIT,
      q: filter.q,
      to: window.to,
      userId,
    });

    for (const topic of topics.items) {
      if (filter.topicId && topic.id !== filter.topicId) continue;

      push({
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

      if (!includeBodies) continue;

      let msgCursor: string | undefined;
      for (;;) {
        await heartbeat();
        const messages = await model.listMessageDetails({
          cursor: msgCursor,
          from: window.from,
          limit: AUDIT_EXPORT_BATCH_LIMIT,
          to: window.to,
          topicId: topic.id,
          userId,
        });

        for (const msg of messages.items) {
          push({
            agentId: msg.agentId,
            // Full body with credential-only masking — no truncation / summarization.
            content: msg.content == null ? null : maskAuditConversationEvidence(msg.content),
            createdAt: toIso(msg.createdAt),
            editorData:
              msg.editorData == null ? null : maskAuditConversationEvidence(msg.editorData),
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

        if (!messages.nextCursor) break;
        msgCursor = messages.nextCursor;
      }
    }

    if (!topics.nextCursor) break;
    topicCursor = topics.nextCursor;
  }
};

const collectUserTimeline = async (
  db: LobeChatDatabase,
  filter: PlatformAuditExportFilterSnapshot,
  window: ExportTimeWindow,
  push: (row: Record<string, unknown>) => void,
  heartbeat: () => Promise<void>,
): Promise<void> => {
  const userId = filter.userId;
  if (!userId) {
    throw new AuditExportInvalidFilterError(
      'userId required in frozen filter for user_timeline export',
    );
  }

  const model = new PlatformAuditConversationModel(db);
  let cursor: string | undefined;

  for (;;) {
    await heartbeat();
    const page = await model.listUserTimeline({
      cursor,
      from: window.from,
      limit: AUDIT_EXPORT_BATCH_LIMIT,
      to: window.to,
      userId,
    });

    for (const item of page.items) {
      push({
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
    }

    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
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

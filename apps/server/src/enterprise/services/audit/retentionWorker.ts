/**
 * Functional worker for platform.audit.retention.v1 jobs (dry_run + execute).
 *
 * Keyset-batched scans, lease renewal, cancellation checks between batches.
 * Counts + job cursor checkpoint atomically (no double-count on retry).
 * Final page always persists a cursor past the last processed item.
 * Lease loss is NOT user cancellation — domain/job stay open for reclaim.
 * Legal-hold skips advance the cursor (no infinite loops).
 * Invalid run/job data is terminal.
 */

import {
  encodeRetentionCursor,
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportKind,
  PlatformAuditExportModel,
  type PlatformAuditLegalHoldItem,
  PlatformAuditLegalHoldModel,
  type PlatformAuditRetentionCounts,
  PlatformAuditRetentionRepository,
  type PlatformAuditRetentionRunItem,
  PlatformAuditRetentionRunModel,
  PlatformJobModel,
  RETENTION_OP_LOG_HOLD_TARGET_TYPES,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAuditService } from '../platformAudit';
import { type AuditExportArtifactStorage, AuditExportPrivateS3Storage } from './exportStorage';
import {
  AUDIT_RETENTION_BATCH_LIMIT,
  AUDIT_RETENTION_DEFAULT_LEASE_MS,
  type AuditRetentionJobCursor,
  parseAuditRetentionJobCursor,
  parseAuditRetentionJobInput,
  PLATFORM_AUDIT_RETENTION_JOB_TYPE,
} from './retentionConstants';

export interface ProcessNextAuditRetentionOptions {
  /**
   * Test seam: invoked after each successful atomic batch checkpoint.
   * Throw to simulate transient failure after progress/cursor are durable.
   */
  afterBatchCheckpoint?: (info: {
    batchIndex: number;
    counts: PlatformAuditRetentionCounts;
    keyset: string | undefined;
  }) => Promise<void> | void;
  /**
   * Test seam: after domain `complete` succeeds, before `jobs.complete`.
   * Used to simulate final-step lease loss without cancelling the domain.
   */
  afterDomainComplete?: (info: { jobId: string; runId: string }) => Promise<void> | void;
  leaseMs?: number;
  storage?: AuditExportArtifactStorage;
  workerId: string;
}

export interface ProcessNextAuditRetentionResult {
  claimed: boolean;
  jobId?: string;
  outcome?: 'cancelled' | 'completed' | 'failed' | 'retry' | 'skipped';
  runId?: string;
}

/** Explicit domain/job cancellation only — never lease loss. */
class AuditRetentionCancelledError extends Error {
  constructor() {
    super('AUDIT_RETENTION_CANCELLED');
    this.name = 'AuditRetentionCancelledError';
  }
}

/** Checkpoint returned null / lease owner changed — do not cancel domain or job. */
export class AuditRetentionLeaseLostError extends Error {
  constructor() {
    super('AUDIT_RETENTION_LEASE_LOST');
    this.name = 'AuditRetentionLeaseLostError';
  }
}

class AuditRetentionInvalidDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditRetentionInvalidDataError';
  }
}

const isTerminalContractError = (error: unknown): boolean =>
  error instanceof AuditRetentionInvalidDataError;

const mergeCounts = (
  base: PlatformAuditRetentionCounts,
  delta: PlatformAuditRetentionCounts,
): PlatformAuditRetentionCounts => {
  const out: PlatformAuditRetentionCounts = { ...base };
  for (const [key, value] of Object.entries(delta) as [
    keyof PlatformAuditRetentionCounts,
    number | undefined,
  ][]) {
    if (typeof value !== 'number') continue;
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
};

const progressFromCounts = (counts: PlatformAuditRetentionCounts): number =>
  (counts.operationLogsScanned ?? 0) +
  (counts.topicsScanned ?? 0) +
  (counts.exportArtifactsScanned ?? 0);

type HoldIndex = {
  global: boolean;
  sessions: Set<string>;
  topics: Set<string>;
  users: Set<string>;
  workspaces: Set<string>;
};

const buildHoldIndex = (holds: PlatformAuditLegalHoldItem[]): HoldIndex => {
  const index: HoldIndex = {
    global: false,
    sessions: new Set(),
    topics: new Set(),
    users: new Set(),
    workspaces: new Set(),
  };
  for (const h of holds) {
    if (h.scopeType === 'global') {
      index.global = true;
      continue;
    }
    if (!h.scopeId) continue;
    if (h.scopeType === 'user') index.users.add(h.scopeId);
    else if (h.scopeType === 'session') index.sessions.add(h.scopeId);
    else if (h.scopeType === 'topic') index.topics.add(h.scopeId);
    else if (h.scopeType === 'workspace') index.workspaces.add(h.scopeId);
  }
  return index;
};

const loadHoldIndex = async (db: LobeChatDatabase): Promise<HoldIndex> => {
  // Full active inventory (global + scoped) — findActiveScopes([]) only returns global.
  const holds = await new PlatformAuditLegalHoldModel(db).listActive();
  return buildHoldIndex(holds);
};

const isHoldTargetType = (targetType: string): boolean =>
  (RETENTION_OP_LOG_HOLD_TARGET_TYPES as readonly string[]).includes(targetType);

/**
 * Over-skip: if any matching hold could protect the row, skip.
 * Whitelisted targetType+targetId + actorUserId for user holds.
 */
const operationLogHeld = (
  index: HoldIndex,
  row: {
    actorUserId: string | null;
    targetId: string | null;
    targetType: string;
  },
): boolean => {
  if (index.global) return true;
  if (row.actorUserId && index.users.has(row.actorUserId)) return true;
  if (row.targetId && isHoldTargetType(row.targetType)) {
    if (row.targetType === 'user' && index.users.has(row.targetId)) return true;
    if (row.targetType === 'session' && index.sessions.has(row.targetId)) return true;
    if (row.targetType === 'topic' && index.topics.has(row.targetId)) return true;
    if (row.targetType === 'workspace' && index.workspaces.has(row.targetId)) return true;
  }
  // Over-skip: unknown targetType with a targetId that matches any held id of any type.
  if (
    row.targetId &&
    !isHoldTargetType(row.targetType) &&
    (index.users.has(row.targetId) ||
      index.sessions.has(row.targetId) ||
      index.topics.has(row.targetId) ||
      index.workspaces.has(row.targetId))
  ) {
    return true;
  }
  return false;
};

const topicHeld = (
  index: HoldIndex,
  row: {
    id: string;
    sessionId: string | null;
    userId: string;
    workspaceId: string | null;
  },
): boolean => {
  if (index.global) return true;
  if (index.users.has(row.userId)) return true;
  if (index.topics.has(row.id)) return true;
  if (row.sessionId && index.sessions.has(row.sessionId)) return true;
  if (row.workspaceId && index.workspaces.has(row.workspaceId)) return true;
  return false;
};

const hasAnyScopedHold = (index: HoldIndex): boolean =>
  index.users.size > 0 ||
  index.topics.size > 0 ||
  index.sessions.size > 0 ||
  index.workspaces.size > 0;

/**
 * Conservative legal-hold gate for derived export artifacts.
 *
 * Exports are frozen evidence packages. Prefer over-retention: if the frozen
 * filter can include evidence under any active legal hold, skip purge.
 *
 * Policy branches on the actual export `kind` (`operation_logs` vs
 * `conversations` / `user_timeline`), never on filter-field heuristics.
 * (`q` is valid for operation-log exports and must not reclassify them.)
 *
 * Covered:
 * - Exact scopes: userId, actorUserId(s), topicId, sessionId, workspaceId
 * - Whitelisted / over-skip targetType+targetId (mirrors operationLogHeld)
 * - Broad operation-log filters when any non-global hold exists
 * - Broad conversation/user_timeline filters when topic/session/workspace holds
 *   could still fall inside the export (userId/q without a tighter pin)
 * - Partially narrowed filters that still cannot exclude remaining hold classes
 */
const exportArtifactHeld = (
  index: HoldIndex,
  kind: PlatformAuditExportKind,
  filterSnapshot: PlatformAuditExportFilterSnapshot | null | undefined,
): boolean => {
  if (index.global) return true;
  if (!hasAnyScopedHold(index)) return false;

  const f = filterSnapshot ?? {};

  // Exact identity / scope fields frozen on the export.
  if (f.userId && index.users.has(f.userId)) return true;
  if (f.actorUserId && index.users.has(f.actorUserId)) return true;
  if (f.actorUserIds?.some((id) => index.users.has(id))) return true;
  if (f.topicId && index.topics.has(f.topicId)) return true;
  if (f.sessionId && index.sessions.has(f.sessionId)) return true;
  if (f.workspaceId && index.workspaces.has(f.workspaceId)) return true;

  // Whitelisted targetType+targetId, plus over-skip for unknown/missing types.
  if (f.targetId) {
    const tt = f.targetType;
    if (tt && isHoldTargetType(tt)) {
      if (tt === 'user' && index.users.has(f.targetId)) return true;
      if (tt === 'session' && index.sessions.has(f.targetId)) return true;
      if (tt === 'topic' && index.topics.has(f.targetId)) return true;
      if (tt === 'workspace' && index.workspaces.has(f.targetId)) return true;
    } else if (
      index.users.has(f.targetId) ||
      index.sessions.has(f.targetId) ||
      index.topics.has(f.targetId) ||
      index.workspaces.has(f.targetId)
    ) {
      return true;
    }
  }

  const hasActorPin = Boolean(f.actorUserId) || Boolean(f.actorUserIds?.length);
  const hasTopicPin = Boolean(f.topicId);
  const hasSessionPin = Boolean(f.sessionId);
  const hasWorkspacePin = Boolean(f.workspaceId);
  const hasAnyTargetPin = Boolean(f.targetId) && Boolean(f.targetType);
  const hasHoldTargetPin =
    Boolean(f.targetId) && Boolean(f.targetType) && isHoldTargetType(f.targetType!);

  const isOperationLogs = kind === 'operation_logs';
  const isConversationKind = kind === 'conversations' || kind === 'user_timeline';

  // Broad operation-log filters (time/action/result/q, or empty): any scoped hold.
  // Do not infer kind from `q` — it is a valid operation_logs filter field.
  if (isOperationLogs && !hasActorPin && !hasAnyTargetPin) {
    return true;
  }

  // Broad conversation / user_timeline: userId or title query without a tighter pin
  // can include held topics, sessions, or workspaces under that user.
  if (
    isConversationKind &&
    !hasTopicPin &&
    !hasSessionPin &&
    !hasWorkspacePin &&
    (index.topics.size > 0 || index.sessions.size > 0 || index.workspaces.size > 0)
  ) {
    return true;
  }

  if (isOperationLogs) {
    // Actor pin without hold-relevant target pin: held users can still appear as
    // targets; held topics/sessions/workspaces can appear as targets.
    if (hasActorPin && !hasHoldTargetPin) {
      if (index.users.size > 0) return true;
      if (index.topics.size > 0 || index.sessions.size > 0 || index.workspaces.size > 0) {
        return true;
      }
    }
    // Hold-relevant target pin without actor pin: held users can appear as actors.
    if (hasHoldTargetPin && !hasActorPin && index.users.size > 0) {
      return true;
    }
    // Non-hold target type (e.g. settings) without actor pin: held users as actors.
    if (hasAnyTargetPin && !hasHoldTargetPin && !hasActorPin && index.users.size > 0) {
      return true;
    }
  }

  if (isConversationKind) {
    // Exact topic pin does not prove session/workspace membership is free of holds.
    if (hasTopicPin && (index.sessions.size > 0 || index.workspaces.size > 0)) {
      return true;
    }
    // Exact session pin does not prove nested topics/workspaces are free of holds.
    if (hasSessionPin && !hasTopicPin && (index.topics.size > 0 || index.workspaces.size > 0)) {
      return true;
    }
    // Exact workspace pin does not prove nested topics/sessions are free of holds.
    if (
      hasWorkspacePin &&
      !hasTopicPin &&
      !hasSessionPin &&
      (index.topics.size > 0 || index.sessions.size > 0)
    ) {
      return true;
    }
  }

  return false;
};

const appendWorkerOutcome = async (
  db: LobeChatDatabase,
  params: {
    counts?: PlatformAuditRetentionCounts;
    mode: string;
    outcome: 'cancelled' | 'completed' | 'failed';
    requestedBy: string;
    result: 'success' | 'failure';
    runId: string;
    scope: string;
    errorCode?: string;
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
  } catch {
    // best-effort — never block worker terminal path
  }
};

/**
 * Claim and process at most one audit retention job.
 * Safe to call in a poller loop; returns claimed=false when the queue is empty.
 */
export const processNextAuditRetentionJob = async (
  db: LobeChatDatabase,
  options: ProcessNextAuditRetentionOptions,
): Promise<ProcessNextAuditRetentionResult> => {
  const jobs = new PlatformJobModel(db);
  const runsModel = new PlatformAuditRetentionRunModel(db);
  const repo = new PlatformAuditRetentionRepository(db);
  const leaseMs = options.leaseMs ?? AUDIT_RETENTION_DEFAULT_LEASE_MS;
  // Storage is only resolved when export_artifacts execute needs it.
  let storage: AuditExportArtifactStorage | undefined = options.storage;

  const claimed = await jobs.claimNext({
    leaseMs,
    types: [PLATFORM_AUDIT_RETENTION_JOB_TYPE],
    workerId: options.workerId,
  });
  if (!claimed) return { claimed: false };

  const parsedInput = parseAuditRetentionJobInput(claimed.input);
  if (!parsedInput) {
    await jobs.fail({
      error: { code: 'INVALID_INPUT', message: 'runId missing from job input' },
      jobId: claimed.id,
      terminal: true,
      workerId: options.workerId,
    });
    return { claimed: true, jobId: claimed.id, outcome: 'failed' };
  }

  const runId = parsedInput.runId;

  try {
    const run = await runsModel.get(runId);
    if (!run) {
      await jobs.fail({
        error: { code: 'NOT_FOUND', message: 'retention run missing' },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      return { claimed: true, jobId: claimed.id, outcome: 'failed', runId };
    }

    if (run.status === 'cancelled') {
      await jobs.cancel(claimed.id);
      return { claimed: true, jobId: claimed.id, outcome: 'cancelled', runId };
    }

    if (run.status === 'completed') {
      await jobs.complete({
        jobId: claimed.id,
        resultSummary: { runId, counts: run.counts },
        workerId: options.workerId,
      });
      return { claimed: true, jobId: claimed.id, outcome: 'skipped', runId };
    }

    if (run.status === 'failed') {
      await jobs.fail({
        error: { code: 'RUN_TERMINAL', message: 'retention run already failed' },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      return { claimed: true, jobId: claimed.id, outcome: 'skipped', runId };
    }

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

    // pending → running (or re-enter running after lease recovery / retry)
    if (run.status === 'pending') {
      await runsModel.updateProgress(runId, {
        markRunning: true,
        counts: run.counts ?? {},
      });
    }

    let counts: PlatformAuditRetentionCounts = { ...run.counts };
    // Resume cursor from job (never re-scan already advanced keyset).
    const resumeCursor = parseAuditRetentionJobCursor(claimed.cursor);
    if (claimed.cursor != null && resumeCursor === null) {
      throw new AuditRetentionInvalidDataError('Invalid job cursor');
    }
    let keyset: string | undefined = resumeCursor?.keyset ?? undefined;
    let batchIndex = 0;

    /** Explicit cancel only (domain or platform job status). */
    const assertNotCancelled = async () => {
      const current = await runsModel.get(runId);
      if (!current || current.status === 'cancelled') {
        throw new AuditRetentionCancelledError();
      }
      const job = await jobs.findById(claimed.id);
      if (!job || job.status === 'cancelled') {
        throw new AuditRetentionCancelledError();
      }
    };

    /**
     * Atomic DB checkpoint: retention run counts/progress + platform job cursor/lease.
     * Either both commit or both roll back. Null job checkpoint → LeaseLost (not cancel).
     * Always writes cursor for the last processed item, including final page.
     */
    const checkpointBatch = async (
      nextCounts: PlatformAuditRetentionCounts,
      nextKeyset: string,
    ) => {
      await assertNotCancelled();

      await db.transaction(async (tx) => {
        const runsTx = new PlatformAuditRetentionRunModel(tx);
        const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);

        const updated = await runsTx.updateProgress(runId, {
          counts: nextCounts,
          progressDone: progressFromCounts(nextCounts),
        });
        if (!updated) {
          // Domain became terminal mid-batch (explicit cancel race).
          throw new AuditRetentionCancelledError();
        }

        const cursorPayload: AuditRetentionJobCursor = { keyset: nextKeyset, v: 1 };
        const cp = await jobsTx.checkpoint({
          cursor: cursorPayload,
          jobId: claimed.id,
          leaseMs,
          progressDone: progressFromCounts(nextCounts),
          workerId: options.workerId,
        });
        if (!cp) {
          // Lease owner changed / lease expired — roll back progress write with the tx.
          throw new AuditRetentionLeaseLostError();
        }
      });

      keyset = nextKeyset;
      counts = nextCounts;
      batchIndex += 1;

      if (options.afterBatchCheckpoint) {
        await options.afterBatchCheckpoint({
          batchIndex,
          counts: nextCounts,
          keyset: nextKeyset,
        });
      }
    };

    /** Heartbeat lease without advancing counts (pre-scan / between scopes). */
    const renewLease = async () => {
      await assertNotCancelled();
      const cursorPayload: AuditRetentionJobCursor = { keyset: keyset ?? null, v: 1 };
      const cp = await jobs.checkpoint({
        cursor: cursorPayload,
        jobId: claimed.id,
        leaseMs,
        progressDone: progressFromCounts(counts),
        workerId: options.workerId,
      });
      if (!cp) {
        throw new AuditRetentionLeaseLostError();
      }
    };

    await renewLease();

    if (run.scope === 'operation_logs') {
      counts = await processOperationLogs({
        checkpointBatch,
        counts,
        cutoffAt: run.cutoffAt,
        db,
        execute: run.mode === 'execute',
        getKeyset: () => keyset,
        renewLease,
        repo,
        setKeyset: (c) => {
          keyset = c;
        },
      });
    } else if (run.scope === 'conversations') {
      counts = await processConversations({
        checkpointBatch,
        counts,
        cutoffAt: run.cutoffAt,
        db,
        execute: run.mode === 'execute',
        getKeyset: () => keyset,
        renewLease,
        repo,
        setKeyset: (c) => {
          keyset = c;
        },
      });
    } else {
      if (run.mode === 'execute' && !storage) {
        storage = new AuditExportPrivateS3Storage();
      }
      counts = await processExportArtifacts({
        checkpointBatch,
        counts,
        cutoffAt: run.cutoffAt,
        db,
        execute: run.mode === 'execute',
        getKeyset: () => keyset,
        renewLease,
        repo,
        setKeyset: (c) => {
          keyset = c;
        },
        storage,
      });
    }

    await assertNotCancelled();
    await renewLease();

    // Ensure sessionsDeleted is explicit 0 for conversation scope
    if (run.scope === 'conversations') {
      counts = { ...counts, sessionsDeleted: 0 };
    }

    const completed = await runsModel.complete(runId, { counts });
    if (!completed) {
      // Explicit cancel race at completion — not lease loss.
      await jobs.cancel(claimed.id);
      return { claimed: true, jobId: claimed.id, outcome: 'cancelled', runId };
    }

    if (options.afterDomainComplete) {
      await options.afterDomainComplete({ jobId: claimed.id, runId });
    }

    const jobDone = await jobs.complete({
      jobId: claimed.id,
      resultSummary: {
        counts,
        mode: run.mode,
        runId,
        scope: run.scope,
      },
      workerId: options.workerId,
    });
    if (!jobDone) {
      // Domain already terminal-completed; lease ownership lost — do not report clean
      // completion or cancel domain/job (reclaiming owner finishes platform job).
      return { claimed: true, jobId: claimed.id, outcome: 'skipped', runId };
    }

    await appendWorkerOutcome(db, {
      counts,
      mode: run.mode,
      outcome: 'completed',
      requestedBy: run.requestedBy,
      result: 'success',
      runId,
      scope: run.scope,
    });

    return { claimed: true, jobId: claimed.id, outcome: 'completed', runId };
  } catch (error) {
    if (error instanceof AuditRetentionLeaseLostError) {
      // Lease loss is NOT user cancellation — leave domain + platform job as-is for reclaim.
      return { claimed: true, jobId: claimed.id, outcome: 'skipped', runId };
    }

    if (error instanceof AuditRetentionCancelledError) {
      await runsModel.cancel(runId);
      await jobs.cancel(claimed.id);
      const run = await runsModel.get(runId);
      if (run) {
        await appendWorkerOutcome(db, {
          counts: run.counts,
          mode: run.mode,
          outcome: 'cancelled',
          requestedBy: run.requestedBy,
          result: 'success',
          runId,
          scope: run.scope,
        });
      }
      return { claimed: true, jobId: claimed.id, outcome: 'cancelled', runId };
    }

    const code =
      error instanceof AuditRetentionInvalidDataError
        ? 'INVALID_RUN_DATA'
        : error instanceof Error
          ? error.name || 'RETENTION_FAILED'
          : 'RETENTION_FAILED';
    const message = error instanceof Error ? error.message.slice(0, 500) : 'retention failed';

    if (isTerminalContractError(error)) {
      await runsModel.fail(runId, { code, message });
      await jobs.fail({
        error: { code, message },
        jobId: claimed.id,
        terminal: true,
        workerId: options.workerId,
      });
      const run = await runsModel.get(runId);
      if (run) {
        await appendWorkerOutcome(db, {
          errorCode: code,
          mode: run.mode,
          outcome: 'failed',
          requestedBy: run.requestedBy,
          result: 'failure',
          runId,
          scope: run.scope,
        });
      }
      return { claimed: true, jobId: claimed.id, outcome: 'failed', runId };
    }

    // Transient: requeue job (or dead when maxAttempts exhausted). Domain stays running.
    const failedJob = await jobs.fail({
      error: { code, message },
      jobId: claimed.id,
      workerId: options.workerId,
    });

    if (failedJob?.status === 'dead') {
      await runsModel.fail(runId, { code, message });
      const run = await runsModel.get(runId);
      if (run) {
        await appendWorkerOutcome(db, {
          errorCode: code,
          mode: run.mode,
          outcome: 'failed',
          requestedBy: run.requestedBy,
          result: 'failure',
          runId,
          scope: run.scope,
        });
      }
      return { claimed: true, jobId: claimed.id, outcome: 'failed', runId };
    }

    return { claimed: true, jobId: claimed.id, outcome: 'retry', runId };
  }
};

type ScopeProcessorParams = {
  checkpointBatch: (counts: PlatformAuditRetentionCounts, keyset: string) => Promise<void>;
  counts: PlatformAuditRetentionCounts;
  cutoffAt: Date;
  db: LobeChatDatabase;
  execute: boolean;
  getKeyset: () => string | undefined;
  renewLease: () => Promise<void>;
  repo: PlatformAuditRetentionRepository;
  setKeyset: (cursor: string | undefined) => void;
};

/**
 * Always advance keyset past the last processed item — including the final page
 * (when nextCursor is null) so retries never re-scan that page.
 */
const keysetAfterPage = <T extends { id: string }>(
  page: { items: T[]; nextCursor: string | null },
  sortAtOf: (item: T) => Date,
): string | undefined => {
  const last = page.items.at(-1);
  if (!last) return undefined;
  return page.nextCursor ?? encodeRetentionCursor(sortAtOf(last), last.id);
};

const processOperationLogs = async (
  params: ScopeProcessorParams,
): Promise<PlatformAuditRetentionCounts> => {
  let counts = params.counts;
  for (;;) {
    await params.renewLease();
    const holds = await loadHoldIndex(params.db);
    const page = await params.repo.listOperationLogCandidates({
      cursor: params.getKeyset(),
      cutoffAt: params.cutoffAt,
      limit: AUDIT_RETENTION_BATCH_LIMIT,
    });

    if (page.items.length === 0) break;

    const delta: PlatformAuditRetentionCounts = {
      operationLogsScanned: page.items.length,
      skippedLegalHold: 0,
      operationLogsDeleted: 0,
    };

    const toDelete: string[] = [];
    for (const row of page.items) {
      if (operationLogHeld(holds, row)) {
        delta.skippedLegalHold = (delta.skippedLegalHold ?? 0) + 1;
        continue;
      }
      if (params.execute) toDelete.push(row.id);
    }

    if (params.execute && toDelete.length > 0) {
      // Recheck holds immediately before delete (over-skip).
      const holdsNow = await loadHoldIndex(params.db);
      const stillOk = toDelete.filter((id) => {
        const row = page.items.find((r) => r.id === id);
        return row && !operationLogHeld(holdsNow, row);
      });
      if (stillOk.length > 0) {
        const deleted = await params.repo.deleteOperationLogsRechecked({
          cutoffAt: params.cutoffAt,
          ids: stillOk,
        });
        delta.operationLogsDeleted = deleted;
      }
    }

    const nextCounts = mergeCounts(counts, delta);
    const nextKeyset = keysetAfterPage(page, (row) => row.createdAt);
    if (!nextKeyset) break;

    // Atomic: counts + cursor (incl. final page) before continuing / completing.
    await params.checkpointBatch(nextCounts, nextKeyset);
    counts = nextCounts;
    params.setKeyset(nextKeyset);

    if (!page.nextCursor) break;
  }
  return counts;
};

const processConversations = async (
  params: ScopeProcessorParams,
): Promise<PlatformAuditRetentionCounts> => {
  let counts = params.counts;
  // Explicit: this task never deletes sessions.
  counts = { ...counts, sessionsDeleted: counts.sessionsDeleted ?? 0 };

  for (;;) {
    await params.renewLease();
    const holds = await loadHoldIndex(params.db);
    const page = await params.repo.listTopicCandidates({
      cursor: params.getKeyset(),
      cutoffAt: params.cutoffAt,
      limit: AUDIT_RETENTION_BATCH_LIMIT,
    });

    if (page.items.length === 0) break;

    const msgCounts = await params.repo.countMessagesForTopics(page.items.map((t) => t.id));

    const delta: PlatformAuditRetentionCounts = {
      topicsScanned: page.items.length,
      messagesScanned: 0,
      skippedLegalHold: 0,
      topicsDeleted: 0,
      messagesDeleted: 0,
      sessionsDeleted: 0,
      conversationsScanned: page.items.length,
      conversationsDeleted: 0,
    };

    for (const topic of page.items) {
      const msgN = msgCounts.get(topic.id) ?? 0;
      delta.messagesScanned = (delta.messagesScanned ?? 0) + msgN;

      if (topicHeld(holds, topic)) {
        delta.skippedLegalHold = (delta.skippedLegalHold ?? 0) + 1;
        continue;
      }

      if (!params.execute) continue;

      // Recheck hold immediately before delete.
      const holdsNow = await loadHoldIndex(params.db);
      if (topicHeld(holdsNow, topic)) {
        delta.skippedLegalHold = (delta.skippedLegalHold ?? 0) + 1;
        continue;
      }

      const deleted = await params.repo.deleteTopicRechecked({
        cutoffAt: params.cutoffAt,
        topicId: topic.id,
      });
      if (deleted) {
        delta.topicsDeleted = (delta.topicsDeleted ?? 0) + 1;
        delta.conversationsDeleted = (delta.conversationsDeleted ?? 0) + 1;
        delta.messagesDeleted = (delta.messagesDeleted ?? 0) + msgN;
      }
    }

    const nextCounts = mergeCounts(counts, delta);
    const nextKeyset = keysetAfterPage(page, (row) => row.updatedAt);
    if (!nextKeyset) break;

    await params.checkpointBatch(nextCounts, nextKeyset);
    counts = nextCounts;
    params.setKeyset(nextKeyset);

    if (!page.nextCursor) break;
  }

  return { ...counts, sessionsDeleted: 0 };
};

const processExportArtifacts = async (
  params: ScopeProcessorParams & { storage?: AuditExportArtifactStorage },
): Promise<PlatformAuditRetentionCounts> => {
  let counts = params.counts;
  const exportsModel = new PlatformAuditExportModel(params.db);

  for (;;) {
    await params.renewLease();
    const holds = await loadHoldIndex(params.db);
    const page = await params.repo.listExportArtifactCandidates({
      cursor: params.getKeyset(),
      cutoffAt: params.cutoffAt,
      limit: AUDIT_RETENTION_BATCH_LIMIT,
    });

    if (page.items.length === 0) break;

    const delta: PlatformAuditRetentionCounts = {
      exportArtifactsScanned: page.items.length,
      skippedLegalHold: 0,
      exportArtifactsDeleted: 0,
    };

    for (const art of page.items) {
      if (exportArtifactHeld(holds, art.kind, art.filterSnapshot)) {
        delta.skippedLegalHold = (delta.skippedLegalHold ?? 0) + 1;
        continue;
      }

      if (!params.execute) continue;

      const holdsNow = await loadHoldIndex(params.db);
      if (exportArtifactHeld(holdsNow, art.kind, art.filterSnapshot)) {
        delta.skippedLegalHold = (delta.skippedLegalHold ?? 0) + 1;
        continue;
      }

      // Delete private object first (when present), then clear storageKey (preserve finishedAt).
      if (art.storageKey && params.storage) {
        try {
          await params.storage.deleteObject(art.storageKey);
        } catch {
          // best-effort object delete; rethrow so transient retry can reclaim
          throw new Error('AUDIT_RETENTION_ARTIFACT_DELETE_FAILED');
        }
      }

      const cleared = await exportsModel.clearArtifactStorage(art.id);
      if (cleared) {
        delta.exportArtifactsDeleted = (delta.exportArtifactsDeleted ?? 0) + 1;
      }
    }

    const nextCounts = mergeCounts(counts, delta);
    const nextKeyset = keysetAfterPage(page, (row) => row.sortAt);
    if (!nextKeyset) break;

    await params.checkpointBatch(nextCounts, nextKeyset);
    counts = nextCounts;
    params.setKeyset(nextKeyset);

    if (!page.nextCursor) break;
  }

  return counts;
};

/** Process up to `batchLimit` retention jobs (for poller / tests). */
export const runAuditRetentionBatches = async (
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
    const result = await processNextAuditRetentionJob(db, {
      storage: params.storage,
      workerId: params.workerId,
    });
    if (!result.claimed) break;
    processed += 1;
  }
  return processed;
};

export type { PlatformAuditRetentionRunItem };

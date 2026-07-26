import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import {
  type NewPlatformAuditExport,
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportItem,
  type PlatformAuditExportKind,
  platformAuditExports,
  type PlatformAuditExportStatus,
  platformJobs,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { withPlatformAuditRetentionHoldLock } from './auditRetentionHoldLock';
import {
  clampListLimit,
  encodeCreatedAtCursor as encodeCursor,
  parseCreatedAtCursor as parseCursor,
} from './cursor';

export type {
  PlatformAuditExportFilterSnapshot,
  PlatformAuditExportItem,
  PlatformAuditExportKind,
  PlatformAuditExportStatus,
};

/** Durable outbox marker: private key pending external object delete. */
export const ARTIFACT_PURGE_PENDING_CODE = 'ARTIFACT_PURGE_PENDING';
/** Outbox aborted because a legal hold appeared after claim-commit. */
export const ARTIFACT_PURGE_DEFERRED_HOLD_CODE = 'ARTIFACT_PURGE_DEFERRED_HOLD';

/**
 * Purge outbox / publication fencing payload on `platform_audit_exports.error`.
 * Two-phase purge: pending → deleting (DB commit) → external delete → clear.
 *
 * Multi-attempt publication uses attempt-unique object keys. The outbox therefore
 * carries **every** known key (`purgeStorageKeys`, append-on-record) so a rebind
 * cannot orphan an earlier attempt's object. `purgeStorageKey` is the primary key
 * currently in the purge epoch (backward compatible with single-key scans).
 */
export type ExportErrorPayload = {
  /** Fencing token for the active publication attempt (running only). */
  attemptToken?: string;
  code?: string;
  message?: string;
  /** Two-phase purge state after claim / authorize. */
  purgeStatus?: 'pending' | 'deleting';
  /** Primary key currently authorized / pending purge. */
  purgeStorageKey?: string;
  /** All attempt keys that may still exist (append-on-record). */
  purgeStorageKeys?: string[];
  /** Retention run that durably claimed this object for purge. */
  purgeRunId?: string;
  /** Immutable token for the current purge authorization epoch. */
  purgeToken?: string;
} | null;

/** Merge storage keys in first-seen order (deduped). */
export const mergePurgeStorageKeys = (
  ...sources: Array<string | string[] | null | undefined>
): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    const list = Array.isArray(src) ? src : [src];
    for (const key of list) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
};

/**
 * All purge-outbox keys on a row (array + legacy single field).
 */
export const readPurgeOutboxStorageKeys = (error: ExportErrorPayload | undefined): string[] =>
  mergePurgeStorageKeys(error?.purgeStorageKeys, error?.purgeStorageKey);

/**
 * Primary purge-outbox key (first known key). Present when any key is set —
 * domain failure code may still be retained alongside the outbox.
 */
export const readPurgeOutboxStorageKey = (error: ExportErrorPayload | undefined): string | null => {
  const keys = readPurgeOutboxStorageKeys(error);
  return keys[0] ?? null;
};

/** Build the purge-outbox slice of `error` for a known set of keys. */
export const buildPurgeOutboxFields = (
  keys: string[],
  opts?: {
    code?: string;
    message?: string;
    purgeRunId?: string;
    purgeStatus?: 'pending' | 'deleting';
    purgeToken?: string;
  },
): Pick<
  NonNullable<ExportErrorPayload>,
  | 'code'
  | 'message'
  | 'purgeRunId'
  | 'purgeStatus'
  | 'purgeStorageKey'
  | 'purgeStorageKeys'
  | 'purgeToken'
> => {
  const unique = mergePurgeStorageKeys(keys);
  if (unique.length === 0) {
    return {
      code: opts?.code,
      message: opts?.message,
    };
  }
  return {
    code: opts?.code,
    message: opts?.message,
    purgeRunId: opts?.purgeRunId,
    purgeStatus: opts?.purgeStatus ?? 'pending',
    purgeStorageKey: unique[0],
    purgeStorageKeys: unique,
    ...(opts?.purgeToken ? { purgeToken: opts.purgeToken } : {}),
  };
};

export const readPurgeStatus = (
  error: ExportErrorPayload | undefined,
): 'pending' | 'deleting' | null => {
  if (!error?.purgeStatus) return null;
  return error.purgeStatus === 'deleting' || error.purgeStatus === 'pending'
    ? error.purgeStatus
    : null;
};

export const readAttemptToken = (error: ExportErrorPayload | undefined): string | null => {
  const token = error?.attemptToken;
  return token && token.length > 0 ? token : null;
};

/**
 * Whether a candidate legal hold intersects an export artifact's frozen filter.
 * Mirrors retention `exportArtifactHeld` for a single hold (DB-001 scoped block).
 */
export const holdIntersectsExportArtifact = (
  hold: { scopeId: string | null; scopeType: string },
  kind: PlatformAuditExportKind,
  filterSnapshot: PlatformAuditExportFilterSnapshot | null | undefined,
): boolean => {
  if (hold.scopeType === 'global') return true;
  if (!hold.scopeId) return false;

  const f = filterSnapshot ?? {};
  const scopeId = hold.scopeId;
  const scopeType = hold.scopeType;

  if (scopeType === 'user') {
    if (f.userId === scopeId || f.actorUserId === scopeId) return true;
    if (f.actorUserIds?.includes(scopeId)) return true;
    if (f.targetId === scopeId && (f.targetType === 'user' || !f.targetType)) return true;
  }
  if (scopeType === 'topic') {
    if (f.topicId === scopeId) return true;
    if (f.targetId === scopeId && (f.targetType === 'topic' || !f.targetType)) return true;
  }
  if (scopeType === 'session') {
    if (f.sessionId === scopeId) return true;
    if (f.targetId === scopeId && (f.targetType === 'session' || !f.targetType)) return true;
  }
  if (scopeType === 'workspace') {
    if (f.workspaceId === scopeId) return true;
    if (f.targetId === scopeId && (f.targetType === 'workspace' || !f.targetType)) return true;
  }

  // Broad filters: a scoped hold may still cover evidence inside the export.
  const hasActorPin = Boolean(f.actorUserId) || Boolean(f.actorUserIds?.length);
  const hasTopicPin = Boolean(f.topicId);
  const hasSessionPin = Boolean(f.sessionId);
  const hasWorkspacePin = Boolean(f.workspaceId);
  const hasAnyTargetPin = Boolean(f.targetId) && Boolean(f.targetType);
  const isOperationLogs = kind === 'operation_logs';
  const isConversationKind = kind === 'conversations' || kind === 'user_timeline';

  if (isOperationLogs && !hasActorPin && !hasAnyTargetPin) return true;
  if (
    isConversationKind &&
    !hasTopicPin &&
    !hasSessionPin &&
    !hasWorkspacePin &&
    (scopeType === 'topic' || scopeType === 'session' || scopeType === 'workspace')
  ) {
    return true;
  }
  // Actor-only op-log pin still overlaps other held users/topics as targets.
  if (isOperationLogs && hasActorPin && !hasAnyTargetPin) return true;

  return false;
};

export type DeletingPurgeOutboxRow = {
  filterSnapshot: PlatformAuditExportFilterSnapshot | null;
  id: string;
  kind: PlatformAuditExportKind;
  purgeToken: string | null;
  storageKey: string;
};

/** List exports currently in purgeStatus=deleting (object may already be gone). */
export const listDeletingPurgeOutboxes = async (
  db: LobeChatDatabase | Transaction,
  limit = 200,
): Promise<DeletingPurgeOutboxRow[]> => {
  const rows = await db
    .select({
      error: platformAuditExports.error,
      filterSnapshot: platformAuditExports.filterSnapshot,
      id: platformAuditExports.id,
      kind: platformAuditExports.kind,
    })
    .from(platformAuditExports)
    .where(sql`coalesce(${platformAuditExports.error}->>'purgeStatus', '') = 'deleting'`)
    .limit(Math.max(1, Math.min(500, limit)));

  const out: DeletingPurgeOutboxRow[] = [];
  for (const row of rows) {
    const err = row.error as ExportErrorPayload;
    const storageKey = readPurgeOutboxStorageKey(err);
    if (!storageKey) continue;
    out.push({
      // Schema column is notNull; keep `| null` on the public type for callers that
      // treat missing snapshots defensively without widening the select result.
      filterSnapshot: row.filterSnapshot ?? null,
      id: row.id,
      kind: row.kind,
      purgeToken: err?.purgeToken ?? null,
      storageKey,
    });
  }
  return out;
};

/**
 * True when a `deleting` purge outbox intersects the candidate hold scope.
 * Pass `scopeType`/`scopeId` to avoid blocking unrelated holds (DB-001).
 * When scope is omitted, any deleting row matches (legacy global check).
 */
export const hasDeletingPurgeOutboxes = async (
  db: LobeChatDatabase | Transaction,
  scope?: { scopeId: string | null; scopeType: string },
): Promise<boolean> => {
  const rows = await listDeletingPurgeOutboxes(db);
  if (rows.length === 0) return false;
  if (!scope) return true;
  return rows.some((row) => holdIntersectsExportArtifact(scope, row.kind, row.filterSnapshot));
};

/** Max stranded `deleting` rows healed per legal-hold create (bounds lock hold). */
export const RECONCILE_ABSENT_DELETING_LIMIT = 16;
/** Per-object HEAD budget while reconciling (ms). Timeout → leave row for retry. */
export const RECONCILE_OBJECT_EXISTS_TIMEOUT_MS = 1500;

/**
 * Race a HEAD probe against a short timeout so a hanging S3 cannot pin callers.
 * Rejects on timeout (caller treats like HEAD failure — leave outbox pending).
 */
export const withObjectExistsTimeout = async (
  probe: () => Promise<boolean>,
  timeoutMs: number = RECONCILE_OBJECT_EXISTS_TIMEOUT_MS,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OBJECT_EXISTS_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Probe intersecting `deleting` outboxes **outside** the hold advisory lock.
 * Returns rows whose object is already gone so the locked path can finalize
 * without network I/O (R6 — S3 must not pin `pg_advisory_xact_lock`).
 */
export const probeAbsentDeletingOutboxes = async (
  db: LobeChatDatabase | Transaction,
  params: {
    limit?: number;
    objectExists: (storageKey: string) => Promise<boolean>;
    scope?: { scopeId: string | null; scopeType: string };
    timeoutMs?: number;
  },
): Promise<DeletingPurgeOutboxRow[]> => {
  const limit = Math.max(
    1,
    Math.min(RECONCILE_ABSENT_DELETING_LIMIT, params.limit ?? RECONCILE_ABSENT_DELETING_LIMIT),
  );
  const timeoutMs = params.timeoutMs ?? RECONCILE_OBJECT_EXISTS_TIMEOUT_MS;
  const rows = await listDeletingPurgeOutboxes(db, limit);
  const absent: DeletingPurgeOutboxRow[] = [];
  for (const row of rows) {
    if (params.scope && !holdIntersectsExportArtifact(params.scope, row.kind, row.filterSnapshot)) {
      continue;
    }
    try {
      const stillThere = await withObjectExistsTimeout(
        () => params.objectExists(row.storageKey),
        timeoutMs,
      );
      if (!stillThere) absent.push(row);
    } catch {
      // HEAD failure / timeout — leave for retry; do not finalize blindly.
    }
  }
  return absent;
};

/**
 * Finalize rows previously proven absent (no remote I/O). Safe under the hold lock.
 */
export const finalizeAbsentDeletingOutboxes = async (
  db: LobeChatDatabase | Transaction,
  rows: DeletingPurgeOutboxRow[],
): Promise<number> => {
  let healed = 0;
  const model = new PlatformAuditExportModel(db as LobeChatDatabase);
  for (const row of rows) {
    const ok = await model.completeArtifactObjectDelete(
      row.id,
      db,
      row.purgeToken ?? undefined,
      row.storageKey,
    );
    if (ok) healed += 1;
  }
  return healed;
};

/**
 * Self-heal stranded `deleting` rows whose object is already gone (HEAD absent),
 * then re-evaluate. Used by legal-hold create so crash residue does not
 * indefinitely block compliance controls.
 *
 * Prefer {@link probeAbsentDeletingOutboxes} **before** the advisory-lock TX and
 * {@link finalizeAbsentDeletingOutboxes} inside it. This combined helper remains
 * for tests / purge paths; it caps rows and times out each HEAD.
 */
export const reconcileAbsentDeletingOutboxes = async (
  db: LobeChatDatabase | Transaction,
  params: {
    limit?: number;
    objectExists: (storageKey: string) => Promise<boolean>;
    scope?: { scopeId: string | null; scopeType: string };
    timeoutMs?: number;
  },
): Promise<number> => {
  const absent = await probeAbsentDeletingOutboxes(db, params);
  return finalizeAbsentDeletingOutboxes(db, absent);
};

/** Stable code thrown when legal-hold create collides with an intersecting purge. */
export const LEGAL_HOLD_PURGE_IN_PROGRESS_CODE = 'LEGAL_HOLD_PURGE_IN_PROGRESS';

export class LegalHoldPurgeInProgressError extends Error {
  readonly code = LEGAL_HOLD_PURGE_IN_PROGRESS_CODE;
  readonly reason = 'purge_in_progress' as const;
  constructor() {
    super(LEGAL_HOLD_PURGE_IN_PROGRESS_CODE);
    this.name = 'LegalHoldPurgeInProgressError';
  }
}

export interface CreatePlatformAuditExportParams {
  filterSnapshot?: PlatformAuditExportFilterSnapshot;
  /** Soft link to platform_jobs.id (unique when set). */
  includesMessageBodies?: boolean;
  jobId?: string | null;
  kind: PlatformAuditExportKind;
  /** Required actor for accountability. */
  requestedBy: string;
}

export interface ListPlatformAuditExportParams {
  /** Composite cursor `${createdAt.toISOString()}|${id}` (desc). */
  cursor?: string;
  kind?: PlatformAuditExportKind;
  /** Clamped to 1..200 (default 50). */
  limit?: number;
  requestedBy?: string;
  status?: PlatformAuditExportStatus;
}

/**
 * Complete an export: private storage key + checksum + expiresAt are required
 * (DB check + model contract). Never accept signed URLs.
 */
export interface CompletePlatformAuditExportParams {
  artifactBytes?: number | null;
  artifactChecksum: string;
  /**
   * Fencing token bound to this worker attempt. Publication is conditional on the
   * row still carrying the same token (lost races return undefined).
   */
  attemptToken: string;
  expiresAt: Date;
  rowCount?: number | null;
  /** Private object storage key — never a signed download URL. */
  storageKey: string;
}

const TERMINAL_EXPORT_STATUSES: readonly PlatformAuditExportStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'expired',
];

/**
 * Admin audit export repository: create → running → complete/fail/cancel/expired.
 * Artifacts are referenced only via private `storageKey` (never `artifactUrl`).
 */
export class PlatformAuditExportModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  create = async (params: CreatePlatformAuditExportParams): Promise<PlatformAuditExportItem> => {
    if (!params.requestedBy) {
      throw new Error('requestedBy is required for platform audit exports');
    }
    const values: NewPlatformAuditExport = {
      filterSnapshot: params.filterSnapshot ?? {},
      includesMessageBodies: params.includesMessageBodies ?? false,
      jobId: params.jobId ?? null,
      kind: params.kind,
      requestedBy: params.requestedBy,
      status: 'pending',
    };
    const [row] = await this.db.insert(platformAuditExports).values(values).returning();
    if (!row) {
      throw new Error('Failed to create platform audit export');
    }
    return row;
  };

  get = async (id: string): Promise<PlatformAuditExportItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);
    return row;
  };

  /**
   * Soft-link a platform_jobs row after enqueue.
   * Allows pending rows with null jobId, or re-affirming the same jobId.
   */
  setJobId = async (id: string, jobId: string): Promise<PlatformAuditExportItem | undefined> => {
    if (!jobId) throw new Error('jobId is required');
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({ jobId, updatedAt: now })
      .where(
        and(
          eq(platformAuditExports.id, id),
          eq(platformAuditExports.status, 'pending'),
          or(isNull(platformAuditExports.jobId), eq(platformAuditExports.jobId, jobId)),
        ),
      )
      .returning();
    return row;
  };

  list = async (
    params: ListPlatformAuditExportParams = {},
  ): Promise<{ items: PlatformAuditExportItem[]; nextCursor: string | null }> => {
    const limit = clampListLimit(params.limit);
    const conditions = [];

    if (params.kind) conditions.push(eq(platformAuditExports.kind, params.kind));
    if (params.status) conditions.push(eq(platformAuditExports.status, params.status));
    if (params.requestedBy) {
      conditions.push(eq(platformAuditExports.requestedBy, params.requestedBy));
    }

    const parsed = parseCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(platformAuditExports.createdAt, parsed.createdAt),
          and(
            eq(platformAuditExports.createdAt, parsed.createdAt),
            lt(platformAuditExports.id, parsed.id),
          ),
        )!,
      );
    }

    const rows = await this.db
      .select()
      .from(platformAuditExports)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(platformAuditExports.createdAt), desc(platformAuditExports.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  };

  markRunning = async (
    id: string,
    opts?: { jobId?: string | null },
  ): Promise<PlatformAuditExportItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        ...(opts?.jobId !== undefined ? { jobId: opts.jobId } : {}),
        error: null,
        startedAt: now,
        status: 'running',
        updatedAt: now,
      })
      .where(and(eq(platformAuditExports.id, id), eq(platformAuditExports.status, 'pending')))
      .returning();
    return row;
  };

  /**
   * Bind a fencing token to a running export before long remote I/O.
   * Later {@link complete} is conditional on this token still owning the row.
   */
  bindPublicationAttempt = async (
    id: string,
    attemptToken: string,
    executor: LobeChatDatabase | Transaction = this.db,
  ): Promise<PlatformAuditExportItem | undefined> => {
    if (!attemptToken) throw new Error('attemptToken is required');
    const now = new Date();
    const [existing] = await executor
      .select({ error: platformAuditExports.error, status: platformAuditExports.status })
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);
    if (!existing || existing.status !== 'running') return undefined;

    const prior = (existing.error ?? null) as ExportErrorPayload;
    // Preserve every known attempt key across rebind (never orphan prior attempts).
    const priorKeys = readPurgeOutboxStorageKeys(prior);
    const nextError: ExportErrorPayload = {
      attemptToken,
      code: prior?.code,
      message: prior?.message,
      ...(priorKeys.length > 0
        ? {
            ...buildPurgeOutboxFields(priorKeys, {
              purgeStatus: prior?.purgeStatus ?? 'pending',
              purgeToken: prior?.purgeToken,
            }),
          }
        : {}),
    };

    const [row] = await executor
      .update(platformAuditExports)
      .set({ error: nextError, updatedAt: now })
      .where(and(eq(platformAuditExports.id, id), eq(platformAuditExports.status, 'running')))
      .returning();
    return row;
  };

  complete = async (
    id: string,
    params: CompletePlatformAuditExportParams,
  ): Promise<PlatformAuditExportItem | undefined> => {
    if (!params.artifactChecksum) {
      throw new Error('artifactChecksum is required to complete an export');
    }
    if (!params.storageKey) {
      throw new Error('storageKey is required to complete an export (private key, never a URL)');
    }
    if (!params.attemptToken) {
      throw new Error('attemptToken is required to complete an export (fencing)');
    }
    if (!(params.expiresAt instanceof Date) || Number.isNaN(params.expiresAt.getTime())) {
      throw new Error('expiresAt is required to complete an export');
    }

    const now = new Date();
    // SAO-002: never blank the multi-key purge outbox on success. A crash mid-upload
    // leaves attempt-unique objects; rebind preserves them; complete must retain every
    // key other than the published storageKey so retention can still drain orphans.
    const [existing] = await this.db
      .select({ error: platformAuditExports.error })
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);
    const prior = (existing?.error ?? null) as ExportErrorPayload;
    const staleKeys = mergePurgeStorageKeys(readPurgeOutboxStorageKeys(prior)).filter(
      (k) => k !== params.storageKey,
    );
    // Drop attemptToken + domain codes; keep only a pending purge outbox for orphans.
    const nextError: ExportErrorPayload =
      staleKeys.length > 0 ? buildPurgeOutboxFields(staleKeys, { purgeStatus: 'pending' }) : null;

    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        artifactBytes: params.artifactBytes ?? null,
        artifactChecksum: params.artifactChecksum,
        error: nextError,
        expiresAt: params.expiresAt,
        finishedAt: now,
        rowCount: params.rowCount ?? null,
        status: 'completed',
        storageKey: params.storageKey,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          eq(platformAuditExports.status, 'running'),
          // Fenced publication: only the attempt that bound the token may win.
          sql`coalesce(${platformAuditExports.error}->>'attemptToken', '') = ${params.attemptToken}`,
        ),
      )
      .returning();
    return row;
  };

  fail = async (
    id: string,
    error: { code?: string; message?: string },
  ): Promise<PlatformAuditExportItem | undefined> => {
    const now = new Date();
    // Preserve upload-time purge intent across terminal failure (F6).
    // Atomically move any live storageKey into the purge outbox (DB-002 pattern).
    const [existing] = await this.db
      .select({ error: platformAuditExports.error, storageKey: platformAuditExports.storageKey })
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);
    const prior = existing?.error as ExportErrorPayload | undefined;
    const priorKeys = mergePurgeStorageKeys(
      existing?.storageKey,
      readPurgeOutboxStorageKeys(prior),
    );
    const nextError: ExportErrorPayload = {
      code: error.code,
      message: error.message,
      ...(priorKeys.length > 0
        ? buildPurgeOutboxFields(priorKeys, {
            code: error.code,
            message: error.message,
            purgeStatus: prior?.purgeStatus === 'deleting' ? 'deleting' : 'pending',
            purgeToken: prior?.purgeToken,
          })
        : {}),
    };

    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        error: nextError,
        finishedAt: now,
        status: 'failed',
        // Never leave failed + storageKey non-null (stranded from purge recovery).
        ...(priorKeys.length > 0 ? { storageKey: null } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'pending'),
            eq(platformAuditExports.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  cancel = async (id: string): Promise<PlatformAuditExportItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        finishedAt: now,
        status: 'cancelled',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'pending'),
            eq(platformAuditExports.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  /**
   * Transition a completed (or still open) export to `expired`.
   * Idempotent when already expired; refuses other terminal states.
   */
  expired = async (id: string): Promise<PlatformAuditExportItem | undefined> => {
    const existing = await this.get(id);
    if (!existing) return undefined;
    if (existing.status === 'expired') return existing;
    if (existing.status === 'failed' || existing.status === 'cancelled') return undefined;

    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        finishedAt: existing.finishedAt ?? now,
        status: 'expired',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'completed'),
            eq(platformAuditExports.status, 'pending'),
            eq(platformAuditExports.status, 'running'),
          ),
        ),
      )
      .returning();
    return row;
  };

  /**
   * Retention artifact clear: mark expired and clear private storageKey while
   * retaining checksum / bytes / filter snapshot / metadata history.
   * Preserves original finishedAt (completion time) — never overwrites it.
   * Accepts completed or already-expired rows (idempotent storageKey clear).
   */
  clearArtifactStorage = async (id: string): Promise<PlatformAuditExportItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        status: 'expired',
        storageKey: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'completed'),
            eq(platformAuditExports.status, 'expired'),
          ),
        ),
      )
      .returning();
    return row;
  };

  /**
   * Durable tombstone + purge outbox claim for retention.
   *
   * Under the caller's TX (hold lock + hold recheck already applied):
   * 1. Read prior private `storageKey`
   * 2. Clear `storageKey` / mark `expired` so the row leaves the candidate set
   * 3. Persist the key on the row as a purge-pending outbox (`error.purgeStorageKey`)
   *
   * The returned key is for callers that still delete immediately; the **safe**
   * path rechecks holds via {@link authorizeArtifactObjectDelete} immediately
   * before the external object delete, then {@link completeArtifactObjectDelete}.
   * A hold that appears after claim must abort/defer — never destroy held evidence.
   */
  claimArtifactStorageForPurge = async (
    id: string,
    executor: LobeChatDatabase | Transaction = this.db,
    purgeRunId?: string,
  ): Promise<{ id: string; storageKey: string } | undefined> => {
    const [existing] = await executor
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
        status: platformAuditExports.status,
        storageKey: platformAuditExports.storageKey,
      })
      .from(platformAuditExports)
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'completed'),
            eq(platformAuditExports.status, 'expired'),
          ),
          isNotNull(platformAuditExports.storageKey),
        ),
      )
      .limit(1);

    if (!existing?.storageKey) return undefined;

    const now = new Date();
    const [row] = await executor
      .update(platformAuditExports)
      .set({
        // Durable outbox: key survives crash between claim-commit and object delete.
        // Phase 1 only — external delete must not run until purgeStatus='deleting'.
        error: {
          code: ARTIFACT_PURGE_PENDING_CODE,
          // Merge, never replace: a row may already carry orphaned attempt keys from a
          // crashed publication attempt. Dropping them reproduces the SAO-002 defect class.
          ...buildPurgeOutboxFields(
            mergePurgeStorageKeys(
              existing.storageKey,
              readPurgeOutboxStorageKeys(existing.error ?? undefined),
            ),
            {
              code: ARTIFACT_PURGE_PENDING_CODE,
              purgeRunId,
              purgeStatus: 'pending',
            },
          ),
        },
        status: 'expired',
        storageKey: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          isNotNull(platformAuditExports.storageKey),
          or(
            eq(platformAuditExports.status, 'completed'),
            eq(platformAuditExports.status, 'expired'),
          ),
        ),
      )
      .returning({ id: platformAuditExports.id });

    if (!row) return undefined;
    return { id: row.id, storageKey: existing.storageKey };
  };

  /**
   * Final pre-delete authorization for one or more purge outboxes, under the
   * shared retention/hold advisory lock.
   *
   * - Hold free → returns the private storage key (caller may delete the object).
   * - Hold active → restores `storageKey` onto the export (evidence addressable again),
   *   marks outbox deferred, omits from the result (caller must NOT delete).
   *
   * Prefer {@link purgeArtifactObjectsUnderHoldLock} when the external object
   * delete must stay serialized with hold creation (no authorize→delete race).
   */
  authorizeArtifactObjectDeletes = async (
    ids: string[],
    params: {
      db?: LobeChatDatabase;
      resolveHeldIds: (
        tx: Transaction,
        rows: Array<{
          filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
          id: string;
          kind: PlatformAuditExportItem['kind'];
        }>,
      ) => Promise<Set<string>>;
    },
  ): Promise<Array<{ id: string; storageKey: string }>> => {
    if (ids.length === 0) return [];
    const db = params.db ?? (this.db as LobeChatDatabase);

    return withPlatformAuditRetentionHoldLock(db, async (tx) => {
      const { authorized } = await this.recheckPurgeOutboxesUnderTx(tx, ids, params.resolveHeldIds);
      return authorized;
    });
  };

  /**
   * Phase 1 of durable two-phase purge (DB-001): under the hold advisory lock,
   * recheck holds and commit `purgeStatus='deleting'` + an immutable purge token.
   * **No external object delete runs in this transaction.**
   *
   * Callers must delete objects outside the TX, then {@link finalizeArtifactObjectDeletes}.
   * Legal-hold creates serialize behind the same lock and reject while any row is
   * in `deleting` (evidence may already be gone on a prior crash).
   */
  authorizeAndMarkDeletingUnderHoldLock = async (
    ids: string[],
    params: {
      db?: LobeChatDatabase;
      onObjectDeferredHold?: (tx: Transaction, id: string) => Promise<void>;
      resolveHeldIds: (
        tx: Transaction,
        rows: Array<{
          filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
          id: string;
          kind: PlatformAuditExportItem['kind'];
        }>,
      ) => Promise<Set<string>>;
    },
  ): Promise<{
    authorized: Array<{ id: string; purgeToken: string; storageKey: string }>;
    skippedHold: number;
  }> => {
    if (ids.length === 0) return { authorized: [], skippedHold: 0 };
    const db = params.db ?? (this.db as LobeChatDatabase);

    return withPlatformAuditRetentionHoldLock(db, async (tx) => {
      const { authorized, skippedHold, deferredIds } = await this.recheckPurgeOutboxesUnderTx(
        tx,
        ids,
        params.resolveHeldIds,
      );

      if (params.onObjectDeferredHold) {
        for (const id of deferredIds) {
          await params.onObjectDeferredHold(tx, id);
        }
      }

      const marked: Array<{ id: string; purgeToken: string; storageKey: string }> = [];
      const now = new Date();
      for (const item of authorized) {
        const [existing] = await tx
          .select({ error: platformAuditExports.error, status: platformAuditExports.status })
          .from(platformAuditExports)
          .where(eq(platformAuditExports.id, item.id))
          .limit(1);
        const prior = (existing?.error ?? null) as ExportErrorPayload;
        // Reuse token on crash recovery so an in-flight finalize still matches.
        const purgeToken =
          prior?.purgeStatus === 'deleting' && prior.purgeToken
            ? prior.purgeToken
            : `purg_${item.id}_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        // Keep every known attempt key; primary is the key being deleted now.
        const allKeys = mergePurgeStorageKeys(item.storageKey, readPurgeOutboxStorageKeys(prior));
        const domainCode =
          prior?.code &&
          prior.code !== ARTIFACT_PURGE_PENDING_CODE &&
          prior.code !== ARTIFACT_PURGE_DEFERRED_HOLD_CODE
            ? prior.code
            : ARTIFACT_PURGE_PENDING_CODE;
        const [row] = await tx
          .update(platformAuditExports)
          .set({
            error: {
              ...buildPurgeOutboxFields(allKeys, {
                code: domainCode,
                message: prior?.message,
                purgeRunId: prior?.purgeRunId,
                purgeStatus: 'deleting',
                purgeToken,
              }),
              // Primary key under this authorization epoch is the one we will delete.
              purgeStorageKey: item.storageKey,
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(platformAuditExports.id, item.id),
              // Phase 1: terminal rows + completed-with-orphan-attempt-keys (SAO-002).
              // Do not weaken this to include running — that would race live uploads (R7).
              inArray(platformAuditExports.status, ['expired', 'failed', 'cancelled', 'completed']),
              // Only advance outboxes that still carry this storage key.
              sql`(
                coalesce(${platformAuditExports.error}->>'purgeStorageKey', '') = ${item.storageKey}
                OR coalesce(${platformAuditExports.error}->'purgeStorageKeys', '[]'::jsonb) ? ${item.storageKey}
              )`,
            ),
          )
          .returning({ id: platformAuditExports.id });
        if (row) {
          marked.push({ id: item.id, purgeToken, storageKey: item.storageKey });
        }
      }

      return { authorized: marked, skippedHold };
    });
  };

  /**
   * Phase 2 finalize: after external object delete (or HEAD proving absence),
   * clear the outbox only when the purge token still matches.
   */
  finalizeArtifactObjectDeletes = async (
    items: Array<{ id: string; purgeToken: string; storageKey?: string }>,
    params?: {
      onObjectDeleted?: (tx: Transaction, id: string) => Promise<void>;
    },
  ): Promise<number> => {
    if (items.length === 0) return 0;
    let deleted = 0;
    for (const item of items) {
      const ok = await this.completeArtifactObjectDelete(
        item.id,
        this.db,
        item.purgeToken,
        item.storageKey,
      );
      if (ok) {
        deleted += 1;
        if (params?.onObjectDeleted) {
          // Prefer a short TX so accounting is atomic with outbox clear when possible.
          const database = this.db as LobeChatDatabase;
          if (typeof database.transaction === 'function') {
            await database.transaction(async (tx) => {
              // Re-check token already cleared — onObjectDeleted is best-effort attribute.
              await params.onObjectDeleted!(tx, item.id);
            });
          } else {
            await params.onObjectDeleted(this.db as Transaction, item.id);
          }
        }
      }
    }
    return deleted;
  };

  /**
   * Durable two-phase purge orchestration (DB-001):
   * 1) Under hold lock: recheck + mark deleting + commit
   * 2) Outside TX: external object deletes
   * 3) New statements: finalize outbox (and optional accounting)
   *
   * Optional `objectExists` reconciles crash-after-delete: missing object → finalize.
   */
  purgeArtifactObjectsUnderHoldLock = async (
    ids: string[],
    params: {
      db?: LobeChatDatabase;
      deleteObject: (storageKey: string) => Promise<void>;
      /**
       * When true (or returns true), the object is still present. Used to converge
       * `deleting` rows after a crash mid-delete (HEAD/check). Defaults to assuming
       * delete succeeded only when `deleteObject` does not throw.
       */
      objectExists?: (storageKey: string) => Promise<boolean>;
      /**
       * Called after a successful outbox complete. Prefer attribution that does not
       * re-open the hold lock for long remote I/O.
       */
      onObjectDeleted?: (tx: Transaction, id: string) => Promise<void>;
      onObjectDeferredHold?: (tx: Transaction, id: string) => Promise<void>;
      resolveHeldIds: (
        tx: Transaction,
        rows: Array<{
          filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
          id: string;
          kind: PlatformAuditExportItem['kind'];
        }>,
      ) => Promise<Set<string>>;
    },
  ): Promise<{ deleted: number; skippedHold: number }> => {
    if (ids.length === 0) return { deleted: 0, skippedHold: 0 };

    const phase1 = await this.authorizeAndMarkDeletingUnderHoldLock(ids, {
      db: params.db,
      onObjectDeferredHold: params.onObjectDeferredHold,
      resolveHeldIds: params.resolveHeldIds,
    });

    const finalized: Array<{ id: string; purgeToken: string; storageKey: string }> = [];
    for (const item of phase1.authorized) {
      try {
        await params.deleteObject(item.storageKey);
        finalized.push({
          id: item.id,
          purgeToken: item.purgeToken,
          storageKey: item.storageKey,
        });
      } catch {
        // Leave purgeStatus=deleting for retry / HEAD reconciliation.
        if (params.objectExists) {
          try {
            const stillThere = await params.objectExists(item.storageKey);
            if (!stillThere) {
              // Object already gone — converge to deleted.
              finalized.push({
                id: item.id,
                purgeToken: item.purgeToken,
                storageKey: item.storageKey,
              });
            }
          } catch {
            // keep deleting for retry
          }
        }
      }
    }

    // Finalize outside the hold-lock transaction (and after object destroy).
    let deleted = 0;
    for (const item of finalized) {
      const database = (params.db ?? this.db) as LobeChatDatabase;
      const runFinalize = async (executor: LobeChatDatabase | Transaction) => {
        if (
          await this.completeArtifactObjectDelete(
            item.id,
            executor,
            item.purgeToken,
            item.storageKey,
          )
        ) {
          deleted += 1;
          if (params.onObjectDeleted) {
            await params.onObjectDeleted(executor as Transaction, item.id);
          }
        }
      };
      if (typeof database.transaction === 'function') {
        await database.transaction(async (tx) => {
          await runFinalize(tx);
        });
      } else {
        await runFinalize(database);
      }
    }

    // Incomplete batch: leave remaining `deleting` outboxes and fail the worker so
    // the job retries (F6 flaky delete). Successful deletes above are already durable.
    if (phase1.authorized.length > 0 && deleted < phase1.authorized.length) {
      throw new Error('AUDIT_EXPORT_ARTIFACT_DELETE_FAILED');
    }

    return { deleted, skippedHold: phase1.skippedHold };
  };

  /**
   * Shared hold recheck for pending purge outboxes (caller holds the retention lock TX).
   */
  private recheckPurgeOutboxesUnderTx = async (
    tx: Transaction,
    ids: string[],
    resolveHeldIds: (
      tx: Transaction,
      rows: Array<{
        filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
        id: string;
        kind: PlatformAuditExportItem['kind'];
      }>,
    ) => Promise<Set<string>>,
  ): Promise<{
    authorized: Array<{ id: string; storageKey: string }>;
    deferredIds: string[];
    skippedHold: number;
  }> => {
    const existingRows = await tx
      .select({
        error: platformAuditExports.error,
        filterSnapshot: platformAuditExports.filterSnapshot,
        id: platformAuditExports.id,
        kind: platformAuditExports.kind,
        status: platformAuditExports.status,
        storageKey: platformAuditExports.storageKey,
      })
      .from(platformAuditExports)
      .where(inArray(platformAuditExports.id, ids));

    const pending = existingRows
      .map((row) => {
        const rawKeys = readPurgeOutboxStorageKeys(row.error as ExportErrorPayload);
        // Completed rows publish a live storageKey — never schedule that key for purge.
        const keys =
          row.status === 'completed' && row.storageKey
            ? rawKeys.filter((k) => k !== row.storageKey)
            : rawKeys;
        return keys.length > 0
          ? { ...row, keys, liveStorageKey: row.storageKey, storageKey: keys[0]! }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (pending.length === 0) return { authorized: [], deferredIds: [], skippedHold: 0 };

    const heldIds = await resolveHeldIds(
      tx,
      pending.map((r) => ({
        filterSnapshot: r.filterSnapshot,
        id: r.id,
        kind: r.kind,
      })),
    );

    const authorized: Array<{ id: string; storageKey: string }> = [];
    const deferredIds: string[] = [];
    let skippedHold = 0;
    const now = new Date();

    for (const row of pending) {
      if (heldIds.has(row.id)) {
        const prior = (row.error ?? null) as ExportErrorPayload;
        // Never clobber a committed `deleting` epoch (object may already be gone).
        if (prior?.purgeStatus === 'deleting') {
          skippedHold += 1;
          deferredIds.push(row.id);
          continue;
        }
        // Completed + orphan attempt keys: leave published storageKey and multi-key
        // outbox intact (do not restore first orphan over the live artifact).
        if (row.status === 'completed') {
          skippedHold += 1;
          deferredIds.push(row.id);
          continue;
        }
        // Defer: restore addressable primary key; leave status expired so retention
        // may re-scan once the hold is released (storageKey IS NOT NULL).
        await tx
          .update(platformAuditExports)
          .set({
            error: {
              code: ARTIFACT_PURGE_DEFERRED_HOLD_CODE,
              message: 'legal hold active between claim and object delete',
            },
            storageKey: row.storageKey,
            updatedAt: now,
          })
          .where(
            and(
              eq(platformAuditExports.id, row.id),
              // Guard: do not rewrite a deleting epoch (restore would re-point at a
              // possibly-destroyed object and drop purgeToken).
              sql`coalesce(${platformAuditExports.error}->>'purgeStatus', '') <> 'deleting'`,
            ),
          );
        skippedHold += 1;
        deferredIds.push(row.id);
        continue;
      }
      // Expand every attempt key so multi-key outboxes drain completely.
      for (const storageKey of row.keys) {
        authorized.push({ id: row.id, storageKey });
      }
    }

    return { authorized, deferredIds, skippedHold };
  };

  /**
   * Record durable cleanup intent **before** an uploaded object may exist (F6).
   * Survives process crash / claimNext dead-letter without the worker cleanup path.
   * Does not change status; {@link complete} drops only the published key from the
   * outbox and retains every other attempt key for retention drain (SAO-002).
   */
  recordArtifactUploadIntent = async (
    id: string,
    storageKey: string,
    executor: LobeChatDatabase | Transaction = this.db,
    opts?: { attemptToken?: string },
  ): Promise<boolean> => {
    if (!storageKey) return false;
    const now = new Date();
    const [existing] = await executor
      .select({ error: platformAuditExports.error, status: platformAuditExports.status })
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);
    if (!existing || (existing.status !== 'running' && existing.status !== 'pending')) {
      return false;
    }
    const prior = (existing.error ?? null) as ExportErrorPayload;
    // Fenced intent: only the bound attempt may append a cleanup key.
    if (opts?.attemptToken) {
      const bound = readAttemptToken(prior);
      if (bound && bound !== opts.attemptToken) return false;
    }
    // Append — never replace/drop prior attempt keys (orphan-object prevention).
    const allKeys = mergePurgeStorageKeys(readPurgeOutboxStorageKeys(prior), storageKey);

    const fenceOk = opts?.attemptToken
      ? or(
          sql`coalesce(${platformAuditExports.error}->>'attemptToken', '') = ''`,
          sql`coalesce(${platformAuditExports.error}->>'attemptToken', '') = ${opts.attemptToken}`,
        )
      : undefined;

    const domainCode =
      prior?.code &&
      prior.code !== ARTIFACT_PURGE_PENDING_CODE &&
      prior.code !== ARTIFACT_PURGE_DEFERRED_HOLD_CODE
        ? prior.code
        : ARTIFACT_PURGE_PENDING_CODE;

    const [row] = await executor
      .update(platformAuditExports)
      .set({
        error: {
          attemptToken: opts?.attemptToken ?? prior?.attemptToken,
          ...buildPurgeOutboxFields(allKeys, {
            code: domainCode,
            message: prior?.message,
            // Keep deleting if a purge epoch is already open (should be rare on running).
            purgeStatus: prior?.purgeStatus === 'deleting' ? 'deleting' : 'pending',
            purgeToken: prior?.purgeToken,
          }),
          // Latest attempt key is the primary for fast-path cancel/cleanup.
          purgeStorageKey: storageKey,
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'running'),
            eq(platformAuditExports.status, 'pending'),
          ),
          fenceOk,
        ),
      )
      .returning({ id: platformAuditExports.id });
    return Boolean(row);
  };

  /**
   * Promote running exports whose platform job was dead-lettered (lease expiry /
   * attempt budget) into terminal failed + durable purge outbox (F6 / DB-002).
   * claimNext can mark the job dead without invoking the export worker cleanup path.
   *
   * **Atomic**: status→failed, storageKey→null, purge outbox key are one UPDATE so a
   * crash cannot leave `failed + storageKey non-null` stranded from both scans.
   */
  reconcileDeadLetterExportArtifacts = async (params?: {
    /** Fallback object key when no upload intent / storageKey was recorded. */
    buildStorageKey: (exportId: string) => string;
    limit?: number;
  }): Promise<number> => {
    if (!params?.buildStorageKey) return 0;
    const limit = clampListLimit(params.limit);

    // Running domain + dead job: worker never got a chance to fail/enqueue outbox.
    const abandoned = await this.db
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
        storageKey: platformAuditExports.storageKey,
      })
      .from(platformAuditExports)
      .innerJoin(platformJobs, eq(platformAuditExports.jobId, platformJobs.id))
      .where(and(eq(platformAuditExports.status, 'running'), eq(platformJobs.status, 'dead')))
      .orderBy(desc(platformAuditExports.updatedAt), desc(platformAuditExports.id))
      .limit(limit);

    let n = 0;
    const now = new Date();
    for (const row of abandoned) {
      const prior = (row.error ?? null) as ExportErrorPayload;
      // Prefer every recorded attempt key; fallback is attempts/ prefix (not the
      // legacy deterministic filename — attempt keys never write there).
      const known = mergePurgeStorageKeys(row.storageKey, readPurgeOutboxStorageKeys(prior));
      const keys = known.length > 0 ? known : mergePurgeStorageKeys(params.buildStorageKey(row.id));
      // Single conditional UPDATE: no intermediate failed+storageKey state (DB-002).
      const [failed] = await this.db
        .update(platformAuditExports)
        .set({
          error: {
            ...buildPurgeOutboxFields(keys, {
              code: 'EXPORT_FAILED',
              message: prior?.message,
              purgeStatus: 'pending',
            }),
          },
          finishedAt: now,
          status: 'failed',
          storageKey: null,
          updatedAt: now,
        })
        .where(and(eq(platformAuditExports.id, row.id), eq(platformAuditExports.status, 'running')))
        .returning({ id: platformAuditExports.id });
      if (failed) n += 1;
    }
    return n;
  };

  /**
   * Durable purge outbox rows left after claim (storageKey cleared) when the
   * worker crashed or object delete failed before {@link completeArtifactObjectDelete}.
   * Also includes **completed** rows that still carry orphan attempt keys after a
   * crash→retry→success publication (SAO-002) — those keep the live `storageKey`.
   * Candidate scan requires storageKey IS NOT NULL, so failed/cancelled outboxes
   * (storageKey null) must be drained separately from retention candidates.
   */
  listPendingArtifactPurges = async (params?: {
    limit?: number;
  }): Promise<Array<{ id: string; purgeRunId: string | null; storageKey: string }>> => {
    const limit = clampListLimit(params?.limit);
    const rows = await this.db
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
        status: platformAuditExports.status,
        storageKey: platformAuditExports.storageKey,
      })
      .from(platformAuditExports)
      .where(
        and(
          or(
            // Classic outbox: terminal + storageKey cleared.
            and(
              inArray(platformAuditExports.status, ['expired', 'failed', 'cancelled']),
              isNull(platformAuditExports.storageKey),
            ),
            // SAO-002 success path: completed still holds orphan attempt keys in error.
            eq(platformAuditExports.status, 'completed'),
          ),
          // Outbox present: primary key and/or keys array.
          sql`(
            coalesce(${platformAuditExports.error}->>'purgeStorageKey', '') <> ''
            OR jsonb_typeof(${platformAuditExports.error}->'purgeStorageKeys') = 'array'
               AND jsonb_array_length(${platformAuditExports.error}->'purgeStorageKeys') > 0
          )`,
        ),
      )
      .orderBy(desc(platformAuditExports.updatedAt), desc(platformAuditExports.id))
      .limit(limit);

    // One entry per export (primary purge key). Phase-1 recheck expands all attempt keys.
    // For completed rows, never schedule the live published storageKey.
    return rows
      .map((row) => {
        const raw = readPurgeOutboxStorageKeys(row.error as ExportErrorPayload);
        const keys =
          row.status === 'completed' && row.storageKey
            ? raw.filter((k) => k !== row.storageKey)
            : raw;
        const storageKey = keys[0] ?? null;
        const error = row.error as ExportErrorPayload;
        return storageKey
          ? { id: row.id, purgeRunId: error?.purgeRunId ?? null, storageKey }
          : null;
      })
      .filter(
        (row): row is { id: string; purgeRunId: string | null; storageKey: string } => row !== null,
      );
  };

  /**
   * Durable purge outbox for failed / cancelled / expired exports that may still
   * hold a private object (deterministic key or cleared storageKey).
   * Retention {@link listPendingArtifactPurges} drains these until delete confirms.
   */
  enqueueArtifactObjectPurge = async (
    id: string,
    storageKey: string,
    executor: LobeChatDatabase | Transaction = this.db,
  ): Promise<boolean> => {
    if (!storageKey) return false;
    const now = new Date();
    // Preserve domain failure code/message when attaching the purge key (tests + ops).
    const [existing] = await executor
      .select({ error: platformAuditExports.error })
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);
    const prior = (existing?.error ?? null) as ExportErrorPayload;
    // Append — never refuse when a different attempt key is already recorded.
    const allKeys = mergePurgeStorageKeys(readPurgeOutboxStorageKeys(prior), storageKey);
    const domainCode =
      prior?.code && prior.code !== ARTIFACT_PURGE_PENDING_CODE
        ? prior.code
        : ARTIFACT_PURGE_PENDING_CODE;

    const [row] = await executor
      .update(platformAuditExports)
      .set({
        error: {
          ...buildPurgeOutboxFields(allKeys, {
            code: domainCode,
            message: prior?.message,
            purgeStatus: prior?.purgeStatus === 'deleting' ? 'deleting' : 'pending',
            purgeToken: prior?.purgeToken,
          }),
        },
        storageKey: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          or(
            eq(platformAuditExports.status, 'failed'),
            eq(platformAuditExports.status, 'cancelled'),
            eq(platformAuditExports.status, 'expired'),
            // Completed is allowed only for ownership-proven cancel paths; workers
            // that lost publication must not purge a winner's key via this helper.
            eq(platformAuditExports.status, 'completed'),
          ),
        ),
      )
      .returning({ id: platformAuditExports.id });
    return Boolean(row);
  };

  /**
   * Mark purge outbox complete **only** after a successful external object delete.
   * When `purgeToken` is provided, finalize is fenced to that authorization epoch
   * so a stale completer cannot clear a newer outbox.
   * When `deletedStorageKey` is provided (or the primary key is known), only that
   * key is removed; remaining attempt keys stay pending.
   * No-op when the outbox is already cleared or was deferred/restored.
   */
  completeArtifactObjectDelete = async (
    id: string,
    executor: LobeChatDatabase | Transaction = this.db,
    purgeToken?: string,
    deletedStorageKey?: string,
  ): Promise<boolean> => {
    const [existing] = await executor
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
      })
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);

    const prior = existing?.error as ExportErrorPayload | undefined;
    const keys = readPurgeOutboxStorageKeys(prior);
    if (keys.length === 0) return false;
    if (purgeToken && prior?.purgeToken && prior.purgeToken !== purgeToken) return false;

    const removeKey = deletedStorageKey ?? prior?.purgeStorageKey ?? keys[0]!;
    const remaining = keys.filter((k) => k !== removeKey);

    // Keep domain fail/cancel codes for operators & tests.
    const domainCode =
      prior?.code && prior.code !== ARTIFACT_PURGE_PENDING_CODE ? prior.code : undefined;
    const domainMessage = domainCode ? prior?.message : undefined;

    // If more attempt keys remain, keep the authorization epoch (token + deleting)
    // so a multi-key purge batch can finalize each key with the same fence.
    const nextError: ExportErrorPayload =
      remaining.length > 0
        ? {
            ...buildPurgeOutboxFields(remaining, {
              code: domainCode ?? ARTIFACT_PURGE_PENDING_CODE,
              message: domainMessage,
              purgeRunId: prior?.purgeRunId,
              purgeStatus: prior?.purgeStatus === 'deleting' ? 'deleting' : 'pending',
              purgeToken: prior?.purgeStatus === 'deleting' ? prior.purgeToken : undefined,
            }),
          }
        : domainCode
          ? { code: domainCode, message: domainMessage }
          : null;

    const [row] = await executor
      .update(platformAuditExports)
      .set({
        error: nextError,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          // Only clear while a purge key is still present (lost races stay safe).
          sql`(
            coalesce(${platformAuditExports.error}->>'purgeStorageKey', '') <> ''
            OR jsonb_typeof(${platformAuditExports.error}->'purgeStorageKeys') = 'array'
          )`,
          purgeToken
            ? sql`coalesce(${platformAuditExports.error}->>'purgeToken', '') = ${purgeToken}`
            : undefined,
        ),
      )
      .returning({ id: platformAuditExports.id });

    return Boolean(row);
  };

  /** True when the export is in a terminal lifecycle state. */
  static isTerminal = (status: PlatformAuditExportStatus): boolean =>
    TERMINAL_EXPORT_STATUSES.includes(status);
}

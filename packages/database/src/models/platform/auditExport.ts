import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import {
  type NewPlatformAuditExport,
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportItem,
  type PlatformAuditExportKind,
  platformAuditExports,
  type PlatformAuditExportStatus,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformAuditExportPurgeOps } from './auditExportPurge';
import type { ExportErrorPayload } from './auditExportPurgeOutbox';
import {
  ARTIFACT_PURGE_DEFERRED_HOLD_CODE,
  ARTIFACT_PURGE_PENDING_CODE,
  buildPurgeOutboxFields,
  mergePurgeStorageKeys,
  readAttemptToken,
  readPurgeOutboxStorageKeys,
} from './auditExportPurgeOutbox';
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
export { holdIntersectsExportArtifact } from './auditExportHolds';
export {
  finalizeAbsentDeletingOutboxes,
  LEGAL_HOLD_PURGE_IN_PROGRESS_CODE,
  LegalHoldPurgeInProgressError,
  reconcileAbsentDeletingOutboxes,
} from './auditExportPurge';
export type { DeletingPurgeOutboxRow, ExportErrorPayload } from './auditExportPurgeOutbox';
export {
  ARTIFACT_PURGE_DEFERRED_HOLD_CODE,
  ARTIFACT_PURGE_PENDING_CODE,
  buildPurgeOutboxFields,
  hasDeletingPurgeOutboxes,
  listDeletingPurgeOutboxes,
  mergePurgeStorageKeys,
  probeAbsentDeletingOutboxes,
  readAttemptToken,
  readPurgeOutboxStorageKey,
  readPurgeOutboxStorageKeys,
  RECONCILE_ABSENT_DELETING_LIMIT,
  RECONCILE_OBJECT_EXISTS_TIMEOUT_MS,
  withObjectExistsTimeout,
} from './auditExportPurgeOutbox';

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
export class PlatformAuditExportModel extends PlatformAuditExportPurgeOps {
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

  /** True when the export is in a terminal lifecycle state. */
  static isTerminal = (status: PlatformAuditExportStatus): boolean =>
    TERMINAL_EXPORT_STATUSES.includes(status);
}

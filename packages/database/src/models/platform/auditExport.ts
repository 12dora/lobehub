import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import {
  type NewPlatformAuditExport,
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportItem,
  type PlatformAuditExportKind,
  platformAuditExports,
  type PlatformAuditExportStatus,
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

type ExportErrorPayload = {
  code?: string;
  message?: string;
  purgeStorageKey?: string;
} | null;

export const readPurgeOutboxStorageKey = (error: ExportErrorPayload | undefined): string | null => {
  if (!error || error.code !== ARTIFACT_PURGE_PENDING_CODE) return null;
  const key = error.purgeStorageKey;
  return key && key.length > 0 ? key : null;
};

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
    if (!(params.expiresAt instanceof Date) || Number.isNaN(params.expiresAt.getTime())) {
      throw new Error('expiresAt is required to complete an export');
    }

    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        artifactBytes: params.artifactBytes ?? null,
        artifactChecksum: params.artifactChecksum,
        error: null,
        expiresAt: params.expiresAt,
        finishedAt: now,
        rowCount: params.rowCount ?? null,
        status: 'completed',
        storageKey: params.storageKey,
        updatedAt: now,
      })
      .where(and(eq(platformAuditExports.id, id), eq(platformAuditExports.status, 'running')))
      .returning();
    return row;
  };

  fail = async (
    id: string,
    error: { code?: string; message?: string },
  ): Promise<PlatformAuditExportItem | undefined> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformAuditExports)
      .set({
        error,
        finishedAt: now,
        status: 'failed',
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
  ): Promise<{ id: string; storageKey: string } | undefined> => {
    const [existing] = await executor
      .select({
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
        error: {
          code: ARTIFACT_PURGE_PENDING_CODE,
          purgeStorageKey: existing.storageKey,
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
   * Hold recheck + external object delete + outbox complete under **one** advisory
   * lock transaction. Legal-hold creates serialize behind this TX, so a hold cannot
   * appear between authorize and object destruction.
   *
   * `deleteObject` runs while the lock is held (keep it fast / idempotent).
   */
  purgeArtifactObjectsUnderHoldLock = async (
    ids: string[],
    params: {
      db?: LobeChatDatabase;
      deleteObject: (storageKey: string) => Promise<void>;
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
    const db = params.db ?? (this.db as LobeChatDatabase);

    return withPlatformAuditRetentionHoldLock(db, async (tx) => {
      const { authorized, skippedHold } = await this.recheckPurgeOutboxesUnderTx(
        tx,
        ids,
        params.resolveHeldIds,
      );

      let deleted = 0;
      for (const item of authorized) {
        await params.deleteObject(item.storageKey);
        if (await this.completeArtifactObjectDelete(item.id, tx)) {
          deleted += 1;
        }
      }

      return { deleted, skippedHold };
    });
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
    skippedHold: number;
  }> => {
    const existingRows = await tx
      .select({
        error: platformAuditExports.error,
        filterSnapshot: platformAuditExports.filterSnapshot,
        id: platformAuditExports.id,
        kind: platformAuditExports.kind,
      })
      .from(platformAuditExports)
      .where(inArray(platformAuditExports.id, ids));

    const pending = existingRows
      .map((row) => {
        const storageKey = readPurgeOutboxStorageKey(row.error);
        return storageKey ? { ...row, storageKey } : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (pending.length === 0) return { authorized: [], skippedHold: 0 };

    const heldIds = await resolveHeldIds(
      tx,
      pending.map((r) => ({
        filterSnapshot: r.filterSnapshot,
        id: r.id,
        kind: r.kind,
      })),
    );

    const authorized: Array<{ id: string; storageKey: string }> = [];
    let skippedHold = 0;
    const now = new Date();

    for (const row of pending) {
      if (heldIds.has(row.id)) {
        // Defer: restore addressable key; leave status expired so retention may
        // re-scan once the hold is released (storageKey IS NOT NULL).
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
          .where(eq(platformAuditExports.id, row.id));
        skippedHold += 1;
        continue;
      }
      authorized.push({ id: row.id, storageKey: row.storageKey });
    }

    return { authorized, skippedHold };
  };

  /**
   * Durable purge outbox rows left after claim (storageKey cleared) when the
   * worker crashed or object delete failed before {@link completeArtifactObjectDelete}.
   * Candidate scan requires storageKey IS NOT NULL, so these must be drained separately.
   */
  listPendingArtifactPurges = async (params?: {
    limit?: number;
  }): Promise<Array<{ id: string; storageKey: string }>> => {
    const limit = clampListLimit(params?.limit);
    const rows = await this.db
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
      })
      .from(platformAuditExports)
      .where(
        and(
          eq(platformAuditExports.status, 'expired'),
          isNull(platformAuditExports.storageKey),
          sql`${platformAuditExports.error}->>'code' = ${ARTIFACT_PURGE_PENDING_CODE}`,
        ),
      )
      .orderBy(desc(platformAuditExports.updatedAt), desc(platformAuditExports.id))
      .limit(limit);

    return rows
      .map((row) => {
        const storageKey = readPurgeOutboxStorageKey(row.error);
        return storageKey ? { id: row.id, storageKey } : null;
      })
      .filter((row): row is { id: string; storageKey: string } => row !== null);
  };

  /**
   * Mark purge outbox complete **only** after a successful external object delete.
   * No-op when the outbox is already cleared or was deferred/restored.
   */
  completeArtifactObjectDelete = async (
    id: string,
    executor: LobeChatDatabase | Transaction = this.db,
  ): Promise<boolean> => {
    const [existing] = await executor
      .select({
        error: platformAuditExports.error,
        id: platformAuditExports.id,
      })
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, id))
      .limit(1);

    if (!readPurgeOutboxStorageKey(existing?.error)) return false;

    const [row] = await executor
      .update(platformAuditExports)
      .set({
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(platformAuditExports.id, id),
          // Only clear while still purge-pending (lost races / double-complete stay safe).
          sql`${platformAuditExports.error}->>'code' = ${ARTIFACT_PURGE_PENDING_CODE}`,
        ),
      )
      .returning({ id: platformAuditExports.id });

    return Boolean(row);
  };

  /** True when the export is in a terminal lifecycle state. */
  static isTerminal = (status: PlatformAuditExportStatus): boolean =>
    TERMINAL_EXPORT_STATUSES.includes(status);
}

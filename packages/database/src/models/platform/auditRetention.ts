/**
 * Dedicated retention scan / delete repository methods.
 * Keyset-bounded batches; delete only rechecked candidate ids.
 * Conversation retention deletes topics only (cascade messages/children).
 */

import { and, asc, count, eq, gt, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';

import { messages, topics } from '../../schemas';
import {
  type PlatformAuditExportItem,
  platformAuditExports,
  platformAuditLegalHolds,
  platformAuditLogs,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformAuditExportModel } from './auditExport';
import { acquirePlatformAuditRetentionHoldLock } from './auditRetentionHoldLock';
import { clampListLimit, encodeCompositeCursor, parseCompositeCursor } from './cursor';

/** Topic statuses that must never be purged by chat-history retention. */
export const RETENTION_PROTECTED_TOPIC_STATUSES = ['running', 'paused', 'waitingForHuman'] as const;

/** Statuses eligible for topic purge when past cutoff. */
export const RETENTION_PURGEABLE_TOPIC_STATUSES = [
  'active',
  'completed',
  'failed',
  'archived',
  'unread',
] as const;

/** Legal-hold target types honored on operation_logs (over-skip, never under-skip). */
export const RETENTION_OP_LOG_HOLD_TARGET_TYPES = [
  'user',
  'session',
  'topic',
  'workspace',
] as const;

export type RetentionKeysetCursor = {
  id: string;
  sortAt: string; // ISO
};

export type OperationLogRetentionCandidate = {
  actorUserId: string | null;
  createdAt: Date;
  id: string;
  targetId: string | null;
  targetType: string;
};

export type TopicRetentionCandidate = {
  id: string;
  sessionId: string | null;
  status: string | null;
  updatedAt: Date;
  userId: string;
  workspaceId: string | null;
};

export type ExportArtifactRetentionCandidate = {
  createdAt: Date;
  expiresAt: Date | null;
  filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
  finishedAt: Date | null;
  id: string;
  /** Actual export kind — legal-hold policy must branch on this, never filter heuristics. */
  kind: PlatformAuditExportItem['kind'];
  /** Stable keyset timestamp: finishedAt, coalesced to createdAt only for legacy rows. */
  sortAt: Date;
  status: PlatformAuditExportItem['status'];
  storageKey: string | null;
};

const clampLimit = (limit?: number): number => clampListLimit(limit);

export const encodeRetentionCursor = (sortAt: Date, id: string): string =>
  encodeCompositeCursor(sortAt, id);

export const parseRetentionCursor = (
  cursor: string | undefined,
): { id: string; sortAt: Date } | null => {
  const parsed = parseCompositeCursor(cursor);
  return parsed ? { id: parsed.id, sortAt: parsed.at } : null;
};

/**
 * Retention-specific DB queries. Intentionally separate from append-only audit log model.
 */
/**
 * SQL fragment: active, non-expired legal hold covering a topic candidate.
 * Over-skips (global / user / topic / session / workspace).
 */
const topicProtectedByActiveHoldSql = sql`
  EXISTS (
    SELECT 1
    FROM ${platformAuditLegalHolds} h
    WHERE h.status = 'active'
      AND (h.expires_at IS NULL OR h.expires_at > NOW())
      AND (
        h.scope_type = 'global'
        OR (h.scope_type = 'user' AND h.scope_id = ${topics.userId})
        OR (h.scope_type = 'topic' AND h.scope_id = ${topics.id})
        OR (h.scope_type = 'session' AND h.scope_id IS NOT NULL AND h.scope_id = ${topics.sessionId})
        OR (h.scope_type = 'workspace' AND h.scope_id IS NOT NULL AND h.scope_id = ${topics.workspaceId})
      )
  )
`;

/**
 * SQL fragment: active, non-expired legal hold covering an operation-log row.
 * Mirrors retentionWorker.operationLogHeld over-skip policy.
 */
const operationLogProtectedByActiveHoldSql = sql`
  EXISTS (
    SELECT 1
    FROM ${platformAuditLegalHolds} h
    WHERE h.status = 'active'
      AND (h.expires_at IS NULL OR h.expires_at > NOW())
      AND (
        h.scope_type = 'global'
        OR (
          h.scope_type = 'user'
          AND (
            h.scope_id = ${platformAuditLogs.actorUserId}
            OR (${platformAuditLogs.targetType} = 'user' AND h.scope_id = ${platformAuditLogs.targetId})
          )
        )
        OR (
          h.scope_type = 'session'
          AND ${platformAuditLogs.targetType} = 'session'
          AND h.scope_id = ${platformAuditLogs.targetId}
        )
        OR (
          h.scope_type = 'topic'
          AND ${platformAuditLogs.targetType} = 'topic'
          AND h.scope_id = ${platformAuditLogs.targetId}
        )
        OR (
          h.scope_type = 'workspace'
          AND ${platformAuditLogs.targetType} = 'workspace'
          AND h.scope_id = ${platformAuditLogs.targetId}
        )
        OR (
          h.scope_id IS NOT NULL
          AND ${platformAuditLogs.targetId} IS NOT NULL
          AND h.scope_id = ${platformAuditLogs.targetId}
          AND ${platformAuditLogs.targetType} NOT IN ('user', 'session', 'topic', 'workspace')
        )
      )
  )
`;

export class PlatformAuditRetentionRepository {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  private readonly inTransaction = async <T>(callback: (tx: Transaction) => Promise<T>) => {
    const database = this.db as LobeChatDatabase;
    return typeof database.transaction === 'function'
      ? database.transaction(callback)
      : callback(this.db as Transaction);
  };

  // ── operation logs ────────────────────────────────────────────────────────

  /**
   * Keyset by (createdAt ASC, id ASC) for rows older than cutoff.
   * Ascending so cursor advance is stable under concurrent inserts (new rows are after cutoff).
   */
  listOperationLogCandidates = async (params: {
    cursor?: string;
    cutoffAt: Date;
    limit?: number;
  }): Promise<{ items: OperationLogRetentionCandidate[]; nextCursor: string | null }> => {
    const limit = clampLimit(params.limit);
    const conditions = [lt(platformAuditLogs.createdAt, params.cutoffAt)];

    const parsed = parseRetentionCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          gt(platformAuditLogs.createdAt, parsed.sortAt),
          and(eq(platformAuditLogs.createdAt, parsed.sortAt), gt(platformAuditLogs.id, parsed.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        actorUserId: platformAuditLogs.actorUserId,
        createdAt: platformAuditLogs.createdAt,
        id: platformAuditLogs.id,
        targetId: platformAuditLogs.targetId,
        targetType: platformAuditLogs.targetType,
      })
      .from(platformAuditLogs)
      .where(and(...conditions))
      .orderBy(asc(platformAuditLogs.createdAt), asc(platformAuditLogs.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeRetentionCursor(last.createdAt, last.id) : null,
    };
  };

  /**
   * Delete only the given ids that still match createdAt < cutoff and are not
   * covered by an active legal hold. Hold check + DELETE run under the shared
   * retention/hold advisory lock in one transaction.
   * Returns number of rows actually deleted.
   */
  deleteOperationLogsRechecked = async (params: {
    cutoffAt: Date;
    ids: string[];
    /**
     * Optional open transaction (e.g. atomic delete + retention checkpoint).
     * When set, the caller owns commit/rollback; the shared hold lock is still acquired.
     */
    tx?: Transaction;
  }): Promise<number> => {
    if (params.ids.length === 0) return 0;
    const run = async (tx: Transaction) => {
      await acquirePlatformAuditRetentionHoldLock(tx);
      // Opt-in escape hatch for the append-only audit-log trigger (migration 0145).
      await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
      const deleted = await tx
        .delete(platformAuditLogs)
        .where(
          and(
            inArray(platformAuditLogs.id, params.ids),
            lt(platformAuditLogs.createdAt, params.cutoffAt),
            sql`NOT (${operationLogProtectedByActiveHoldSql})`,
          ),
        )
        .returning({ id: platformAuditLogs.id });
      return deleted.length;
    };
    if (params.tx) return run(params.tx);
    return this.inTransaction(run);
  };

  // ── conversations (topics) ────────────────────────────────────────────────

  /**
   * Candidate topics by updatedAt < cutoff, keyset ascending.
   * Conservative status gate: only null (legacy) + explicit purgeable allowlist.
   * Unknown/future statuses are never scanned (do not invert protected blocklist).
   */
  listTopicCandidates = async (params: {
    cursor?: string;
    cutoffAt: Date;
    limit?: number;
  }): Promise<{ items: TopicRetentionCandidate[]; nextCursor: string | null }> => {
    const limit = clampLimit(params.limit);
    // Null = purgeable legacy; only RETENTION_PURGEABLE_TOPIC_STATUSES otherwise.
    const statusOk = or(
      sql`${topics.status} IS NULL`,
      inArray(topics.status, [...RETENTION_PURGEABLE_TOPIC_STATUSES]),
    )!;
    const whereParts = [lt(topics.updatedAt, params.cutoffAt), statusOk];

    const parsed = parseRetentionCursor(params.cursor);
    if (parsed) {
      whereParts.push(
        or(
          gt(topics.updatedAt, parsed.sortAt),
          and(eq(topics.updatedAt, parsed.sortAt), gt(topics.id, parsed.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        id: topics.id,
        sessionId: topics.sessionId,
        status: topics.status,
        updatedAt: topics.updatedAt,
        userId: topics.userId,
        workspaceId: topics.workspaceId,
      })
      .from(topics)
      .where(and(...whereParts))
      .orderBy(asc(topics.updatedAt), asc(topics.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeRetentionCursor(last.updatedAt, last.id) : null,
    };
  };

  countMessagesForTopics = async (topicIds: string[]): Promise<Map<string, number>> => {
    const map = new Map<string, number>();
    if (topicIds.length === 0) return map;
    const rows = await this.db
      .select({
        count: count().as('count'),
        topicId: messages.topicId,
      })
      .from(messages)
      .where(inArray(messages.topicId, topicIds))
      .groupBy(messages.topicId);
    for (const row of rows) {
      if (row.topicId) map.set(row.topicId, Number(row.count));
    }
    return map;
  };

  /**
   * Delete a single topic after recheck: still past cutoff, still allowlisted,
   * and not covered by an active legal hold. Hold check + DELETE run under the
   * shared retention/hold advisory lock in one transaction.
   * Cascade removes messages/threads/children. Never touches sessions/users/agents.
   * Returns true when the topic row was deleted.
   */
  deleteTopicRechecked = async (params: {
    cutoffAt: Date;
    topicId: string;
    /** Optional open transaction for atomic delete + retention checkpoint. */
    tx?: Transaction;
  }): Promise<boolean> => {
    const run = async (tx: Transaction) => {
      await acquirePlatformAuditRetentionHoldLock(tx);
      const deleted = await tx
        .delete(topics)
        .where(
          and(
            eq(topics.id, params.topicId),
            lt(topics.updatedAt, params.cutoffAt),
            or(
              sql`${topics.status} IS NULL`,
              inArray(topics.status, [...RETENTION_PURGEABLE_TOPIC_STATUSES]),
            )!,
            sql`NOT (${topicProtectedByActiveHoldSql})`,
          ),
        )
        .returning({ id: topics.id });
      return deleted.length > 0;
    };
    if (params.tx) return run(params.tx);
    return this.inTransaction(run);
  };

  // ── export artifacts ──────────────────────────────────────────────────────

  /**
   * Under the shared retention/hold lock: re-load eligibility, let the caller
   * resolve held ids against a fresh hold index (same TX), then durable-tombstone
   * claim each free row (clear storageKey, expire, persist purge outbox).
   * Returns claimed private keys for object-store delete **after** a final
   * {@link authorizeExportArtifactObjectDeletes} hold recheck.
   */
  claimExportArtifactsRechecked = async (params: {
    cutoffAt: Date;
    ids: string[];
    now?: Date;
    /**
     * Called after the advisory lock is held. Must re-query holds and return
     * the set of candidate ids that are still protected.
     */
    resolveHeldIds: (
      tx: Transaction,
      rows: Array<{
        filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
        id: string;
        kind: PlatformAuditExportItem['kind'];
      }>,
    ) => Promise<Set<string>>;
  }): Promise<Array<{ id: string; storageKey: string }>> => {
    if (params.ids.length === 0) return [];
    const now = params.now ?? new Date();
    return this.inTransaction(async (tx) => {
      await acquirePlatformAuditRetentionHoldLock(tx);

      // Re-select still-eligible rows with a private object inside the locked TX.
      const sortAtExpr = sql<Date>`coalesce(${platformAuditExports.finishedAt}, ${platformAuditExports.createdAt})`;
      const eligibility = or(
        sql`${sortAtExpr} < ${params.cutoffAt}`,
        and(isNotNull(platformAuditExports.expiresAt), lte(platformAuditExports.expiresAt, now)),
      )!;

      const rows = await tx
        .select({
          filterSnapshot: platformAuditExports.filterSnapshot,
          id: platformAuditExports.id,
          kind: platformAuditExports.kind,
          storageKey: platformAuditExports.storageKey,
        })
        .from(platformAuditExports)
        .where(
          and(
            inArray(platformAuditExports.id, params.ids),
            inArray(platformAuditExports.status, ['completed', 'expired']),
            isNotNull(platformAuditExports.storageKey),
            eligibility,
          ),
        );

      const heldIds = await params.resolveHeldIds(
        tx,
        rows.map((r) => ({
          filterSnapshot: r.filterSnapshot,
          id: r.id,
          kind: r.kind,
        })),
      );

      const claimed: Array<{ id: string; storageKey: string }> = [];
      const exportsModel = new PlatformAuditExportModel(tx);

      for (const row of rows) {
        if (!row.storageKey) continue;
        if (heldIds.has(row.id)) continue;

        const result = await exportsModel.claimArtifactStorageForPurge(row.id, tx);
        if (result?.storageKey) claimed.push(result);
      }
      return claimed;
    });
  };

  /**
   * Immediate pre-delete hold recheck for claimed purge outboxes.
   * A hold created after claim-commit must abort/defer the object delete and
   * restore `storageKey` so held evidence remains addressable.
   */
  authorizeExportArtifactObjectDeletes = async (params: {
    ids: string[];
    resolveHeldIds: (
      tx: Transaction,
      rows: Array<{
        filterSnapshot: PlatformAuditExportItem['filterSnapshot'];
        id: string;
        kind: PlatformAuditExportItem['kind'];
      }>,
    ) => Promise<Set<string>>;
  }): Promise<Array<{ id: string; storageKey: string }>> => {
    const exportsModel = new PlatformAuditExportModel(this.db);
    return exportsModel.authorizeArtifactObjectDeletes(params.ids, {
      db: this.db as LobeChatDatabase,
      resolveHeldIds: params.resolveHeldIds,
    });
  };

  /**
   * Authorize (hold recheck) + external object delete + complete outbox under one
   * advisory lock TX. Preferred over authorize → delete → complete split, which
   * leaves a hold race after the authorize transaction commits.
   */
  purgeExportArtifactObjectsUnderHoldLock = async (params: {
    deleteObject: (storageKey: string) => Promise<void>;
    ids: string[];
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
  }): Promise<{ deleted: number; skippedHold: number }> => {
    const exportsModel = new PlatformAuditExportModel(this.db);
    return exportsModel.purgeArtifactObjectsUnderHoldLock(params.ids, {
      db: this.db as LobeChatDatabase,
      deleteObject: params.deleteObject,
      onObjectDeleted: params.onObjectDeleted,
      onObjectDeferredHold: params.onObjectDeferredHold,
      resolveHeldIds: params.resolveHeldIds,
    });
  };

  /**
   * Mark purge outboxes complete only after successful external object deletes.
   * Returns the number of outbox rows cleared.
   */
  completeExportArtifactObjectDeletes = async (ids: string[]): Promise<number> => {
    if (ids.length === 0) return 0;
    const exportsModel = new PlatformAuditExportModel(this.db);
    let n = 0;
    for (const id of ids) {
      if (await exportsModel.completeArtifactObjectDelete(id)) n += 1;
    }
    return n;
  };

  /**
   * Crash-recovery scan: purge outboxes with storageKey already cleared that
   * never completed external object delete.
   */
  listPendingExportArtifactPurges = async (params?: {
    limit?: number;
  }): Promise<Array<{ id: string; storageKey: string }>> => {
    const exportsModel = new PlatformAuditExportModel(this.db);
    return exportsModel.listPendingArtifactPurges(params);
  };

  /**
   * F6: dead-lettered export jobs leave domain `running` without worker cleanup.
   * Promote those rows to failed + durable purge outbox so listPending can drain.
   */
  reconcileDeadLetterExportArtifacts = async (params: {
    buildStorageKey: (exportId: string) => string;
    limit?: number;
  }): Promise<number> => {
    const exportsModel = new PlatformAuditExportModel(this.db);
    return exportsModel.reconcileDeadLetterExportArtifacts(params);
  };

  /**
   * completed/expired rows that still hold a private object (`storageKey IS NOT NULL`).
   * Eligibility: finishedAt < cutoff (coalesce to createdAt only for legacy null finishedAt)
   * OR expiresAt <= now — never createdAt alone.
   * Keyset by (sortAt ASC, id ASC) where sortAt = coalesce(finishedAt, createdAt).
   * Already-cleared expired rows (storageKey null) never reappear.
   */
  listExportArtifactCandidates = async (params: {
    cursor?: string;
    cutoffAt: Date;
    limit?: number;
    now?: Date;
  }): Promise<{ items: ExportArtifactRetentionCandidate[]; nextCursor: string | null }> => {
    const limit = clampLimit(params.limit);
    const now = params.now ?? new Date();

    // finishedAt for completed exports; coalesce only so legacy rows without finishedAt still sort/scan.
    const sortAtExpr = sql<Date>`coalesce(${platformAuditExports.finishedAt}, ${platformAuditExports.createdAt})`;

    const eligibility = or(
      sql`${sortAtExpr} < ${params.cutoffAt}`,
      and(isNotNull(platformAuditExports.expiresAt), lte(platformAuditExports.expiresAt, now)),
    )!;

    const conditions = [
      inArray(platformAuditExports.status, ['completed', 'expired']),
      // Cleared artifacts must never re-enter the candidate set.
      isNotNull(platformAuditExports.storageKey),
      eligibility,
    ];

    const parsed = parseRetentionCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          sql`${sortAtExpr} > ${parsed.sortAt}`,
          and(sql`${sortAtExpr} = ${parsed.sortAt}`, gt(platformAuditExports.id, parsed.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        createdAt: platformAuditExports.createdAt,
        expiresAt: platformAuditExports.expiresAt,
        filterSnapshot: platformAuditExports.filterSnapshot,
        finishedAt: platformAuditExports.finishedAt,
        id: platformAuditExports.id,
        kind: platformAuditExports.kind,
        sortAt: sortAtExpr.as('sort_at'),
        status: platformAuditExports.status,
        storageKey: platformAuditExports.storageKey,
      })
      .from(platformAuditExports)
      .where(and(...conditions))
      .orderBy(asc(sortAtExpr), asc(platformAuditExports.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      ...row,
      // Drivers may return string timestamps from sql coalesce — normalize to Date.
      sortAt: row.sortAt instanceof Date ? row.sortAt : new Date(row.sortAt),
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeRetentionCursor(last.sortAt, last.id) : null,
    };
  };
}

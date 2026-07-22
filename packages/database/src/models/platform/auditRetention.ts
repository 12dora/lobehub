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
  platformAuditLogs,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

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
  /** Stable keyset timestamp: finishedAt, coalesced to createdAt only for legacy rows. */
  sortAt: Date;
  status: PlatformAuditExportItem['status'];
  storageKey: string | null;
};

const clampLimit = (limit?: number): number => Math.min(Math.max(Math.floor(limit ?? 50), 1), 200);

export const encodeRetentionCursor = (sortAt: Date, id: string): string =>
  `${sortAt.toISOString()}|${id}`;

export const parseRetentionCursor = (
  cursor: string | undefined,
): { id: string; sortAt: Date } | null => {
  if (!cursor?.includes('|')) return null;
  const [iso, id] = cursor.split('|');
  const sortAt = new Date(iso);
  if (Number.isNaN(sortAt.getTime()) || !id) return null;
  return { id, sortAt };
};

/**
 * Retention-specific DB queries. Intentionally separate from append-only audit log model.
 */
export class PlatformAuditRetentionRepository {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

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
   * Delete only the given ids that still match createdAt < cutoff (recheck).
   * Returns number of rows actually deleted.
   */
  deleteOperationLogsRechecked = async (params: {
    cutoffAt: Date;
    ids: string[];
  }): Promise<number> => {
    if (params.ids.length === 0) return 0;
    const deleted = await this.db
      .delete(platformAuditLogs)
      .where(
        and(
          inArray(platformAuditLogs.id, params.ids),
          lt(platformAuditLogs.createdAt, params.cutoffAt),
        ),
      )
      .returning({ id: platformAuditLogs.id });
    return deleted.length;
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
   * Delete a single topic after recheck: still past cutoff and still allowlisted.
   * Cascade removes messages/threads/children. Never touches sessions/users/agents.
   * Returns true when the topic row was deleted.
   */
  deleteTopicRechecked = async (params: { cutoffAt: Date; topicId: string }): Promise<boolean> => {
    const deleted = await this.db
      .delete(topics)
      .where(
        and(
          eq(topics.id, params.topicId),
          lt(topics.updatedAt, params.cutoffAt),
          or(
            sql`${topics.status} IS NULL`,
            inArray(topics.status, [...RETENTION_PURGEABLE_TOPIC_STATUSES]),
          )!,
        ),
      )
      .returning({ id: topics.id });
    return deleted.length > 0;
  };

  // ── export artifacts ──────────────────────────────────────────────────────

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

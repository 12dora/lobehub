import { and, count, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';

import {
  type NewPlatformAuditLog,
  type PlatformAuditLogItem,
  platformAuditLogs,
} from '../../schemas/platform';
import type { PlatformAuditResult } from '../../schemas/platform/common';
import type { LobeChatDatabase, Transaction } from '../../type';
import { redactSensitive } from './redact';

export type { PlatformAuditLogItem, PlatformAuditResult };

export interface CreatePlatformAuditLogParams {
  action: string;
  actorUserId?: string | null;
  afterDiff?: Record<string, unknown> | null;
  beforeDiff?: Record<string, unknown> | null;
  configRevision?: number | null;
  /** Stable caller-owned identifier for idempotent append-only delivery. */
  id?: string;
  ipHash?: string | null;
  reason?: string | null;
  requestId?: string | null;
  result: PlatformAuditLogItem['result'];
  targetId?: string | null;
  targetType: string;
  userAgent?: string | null;
}

/**
 * Composite cursor: `${createdAt.toISOString()}|${id}` (desc order).
 * Also accepts a bare ISO date string or a valid Date for backward compatibility.
 */
export type PlatformAuditCursor = string;

export interface ListPlatformAuditLogParams {
  action?: string;
  actions?: string[];
  actorUserId?: string;
  /** Composite cursor, legacy ISO date string, or valid Date. */
  cursor?: PlatformAuditCursor | Date;
  from?: Date;
  limit?: number;
  requestId?: string;
  result?: PlatformAuditResult;
  results?: PlatformAuditResult[];
  targetId?: string;
  targetType?: string;
  to?: Date;
}

export interface PlatformAuditLogFacetBucket {
  count: number;
  value: string;
}

export interface PlatformAuditLogFacets {
  actions: PlatformAuditLogFacetBucket[];
  results: PlatformAuditLogFacetBucket[];
}

export interface PlatformAuditLogStats {
  denied: number;
  failure: number;
  success: number;
  total: number;
}

export interface PlatformAuditLogFacetsParams {
  /** Inclusive lower bound (createdAt). */
  from?: Date;
  /** Max distinct values per facet dimension (default 20, max 50). */
  limit?: number;
  /** Exclusive upper bound (createdAt). */
  to?: Date;
}

export interface PlatformAuditLogStatsParams {
  from?: Date;
  to?: Date;
}

export const encodeAuditCursor = (row: Pick<PlatformAuditLogItem, 'createdAt' | 'id'>): string =>
  `${row.createdAt.toISOString()}|${row.id}`;

export const parseAuditCursor = (
  cursor: PlatformAuditCursor | Date | undefined,
): { createdAt: Date; id?: string } | null => {
  if (!cursor) return null;
  if (cursor instanceof Date) {
    if (Number.isNaN(cursor.getTime())) return null;
    return { createdAt: cursor };
  }
  if (cursor.includes('|')) {
    const [iso, id] = cursor.split('|');
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  }
  const createdAt = new Date(cursor);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt };
};

/**
 * Append-only platform audit log repository.
 * There is intentionally no update/delete API on this model.
 */
export class PlatformAuditLogModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  /**
   * Insert a redacted audit row. Sensitive keys/values in diffs are stripped before write.
   */
  append = async (params: CreatePlatformAuditLogParams): Promise<PlatformAuditLogItem> => {
    const values: NewPlatformAuditLog = {
      action: params.action,
      actorUserId: params.actorUserId ?? null,
      afterDiff: params.afterDiff ? redactSensitive(params.afterDiff) : null,
      beforeDiff: params.beforeDiff ? redactSensitive(params.beforeDiff) : null,
      configRevision: params.configRevision ?? null,
      id: params.id,
      ipHash: params.ipHash ?? null,
      reason: params.reason ?? null,
      requestId: params.requestId ?? null,
      result: params.result,
      targetId: params.targetId ?? null,
      targetType: params.targetType,
      userAgent: params.userAgent ?? null,
    };

    if (!params.id) {
      const [row] = await this.db.insert(platformAuditLogs).values(values).returning();
      return row;
    }
    const [row] = await this.db
      .insert(platformAuditLogs)
      .values(values)
      .onConflictDoNothing({ target: platformAuditLogs.id })
      .returning();
    if (row) return row;
    const existing = await this.findById(params.id);
    if (!existing) throw new Error('Failed to append or load idempotent platform audit log');
    return existing;
  };

  findById = async (id: string): Promise<PlatformAuditLogItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.id, id))
      .limit(1);
    return row;
  };

  /**
   * Cursor pagination by (createdAt, id) descending with actor/action/result/time filters.
   * Composite cursor prevents skipping same-millisecond rows.
   * Callers should pass nextCursor as a string (not `new Date(nextCursor)`).
   */
  list = async (
    params: ListPlatformAuditLogParams = {},
  ): Promise<{ items: PlatformAuditLogItem[]; nextCursor: string | null }> => {
    const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 200);
    const conditions = this.buildListConditions(params);

    const rows = await this.db
      .select()
      .from(platformAuditLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(platformAuditLogs.createdAt), desc(platformAuditLogs.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeAuditCursor(last) : null;

    return { items, nextCursor };
  };

  /**
   * Bounded facet counts for admin filter chips (action / result).
   * Caps distinct buckets to avoid unbounded group-by cost.
   */
  getFacets = async (
    params: PlatformAuditLogFacetsParams = {},
  ): Promise<PlatformAuditLogFacets> => {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
    const conditions = this.buildTimeConditions(params.from, params.to);
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [actionRows, resultRows] = await Promise.all([
      this.db
        .select({
          count: count().as('count'),
          value: platformAuditLogs.action,
        })
        .from(platformAuditLogs)
        .where(where)
        .groupBy(platformAuditLogs.action)
        .orderBy(desc(sql`count`), desc(platformAuditLogs.action))
        .limit(limit),
      this.db
        .select({
          count: count().as('count'),
          value: platformAuditLogs.result,
        })
        .from(platformAuditLogs)
        .where(where)
        .groupBy(platformAuditLogs.result)
        .orderBy(desc(sql`count`), desc(platformAuditLogs.result))
        .limit(limit),
    ]);

    return {
      actions: actionRows.map((r) => ({ count: Number(r.count), value: r.value })),
      results: resultRows.map((r) => ({ count: Number(r.count), value: r.value })),
    };
  };

  /** Aggregate success/failure/denied totals within an optional time window. */
  getStats = async (params: PlatformAuditLogStatsParams = {}): Promise<PlatformAuditLogStats> => {
    const conditions = this.buildTimeConditions(params.from, params.to);

    const rows = await this.db
      .select({
        count: count().as('count'),
        result: platformAuditLogs.result,
      })
      .from(platformAuditLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(platformAuditLogs.result);

    const stats: PlatformAuditLogStats = { denied: 0, failure: 0, success: 0, total: 0 };
    for (const row of rows) {
      const n = Number(row.count);
      stats.total += n;
      if (row.result === 'success') stats.success = n;
      else if (row.result === 'failure') stats.failure = n;
      else if (row.result === 'denied') stats.denied = n;
    }
    return stats;
  };

  private buildTimeConditions = (from?: Date, to?: Date) => {
    const conditions = [];
    if (from) conditions.push(gte(platformAuditLogs.createdAt, from));
    if (to) conditions.push(lt(platformAuditLogs.createdAt, to));
    return conditions;
  };

  private buildListConditions = (params: ListPlatformAuditLogParams) => {
    const conditions = this.buildTimeConditions(params.from, params.to);

    if (params.actorUserId) {
      conditions.push(eq(platformAuditLogs.actorUserId, params.actorUserId));
    }
    if (params.action) {
      conditions.push(eq(platformAuditLogs.action, params.action));
    }
    if (params.actions && params.actions.length > 0) {
      conditions.push(inArray(platformAuditLogs.action, params.actions));
    }
    if (params.result) {
      conditions.push(eq(platformAuditLogs.result, params.result));
    }
    if (params.results && params.results.length > 0) {
      conditions.push(inArray(platformAuditLogs.result, params.results));
    }
    if (params.targetType) {
      conditions.push(eq(platformAuditLogs.targetType, params.targetType));
    }
    if (params.targetId) {
      conditions.push(eq(platformAuditLogs.targetId, params.targetId));
    }
    if (params.requestId) {
      conditions.push(eq(platformAuditLogs.requestId, params.requestId));
    }

    const parsed = parseAuditCursor(params.cursor);
    if (parsed) {
      if (parsed.id) {
        conditions.push(
          or(
            lt(platformAuditLogs.createdAt, parsed.createdAt),
            and(
              eq(platformAuditLogs.createdAt, parsed.createdAt),
              lt(platformAuditLogs.id, parsed.id),
            ),
          )!,
        );
      } else {
        conditions.push(lt(platformAuditLogs.createdAt, parsed.createdAt));
      }
    }

    return conditions;
  };
}

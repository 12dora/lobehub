import { and, desc, eq, lt, or, sql } from 'drizzle-orm';

import {
  type NewPlatformAuditLog,
  type PlatformAuditLogItem,
  platformAuditLogs,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { redactSensitive } from './redact';

export type { PlatformAuditLogItem };

export interface CreatePlatformAuditLogParams {
  action: string;
  actorUserId?: string | null;
  afterDiff?: Record<string, unknown> | null;
  beforeDiff?: Record<string, unknown> | null;
  configRevision?: number | null;
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
 * Also accepts a bare ISO date for backward compatibility.
 */
export type PlatformAuditCursor = string;

export interface ListPlatformAuditLogParams {
  actorUserId?: string;
  /** Composite cursor or legacy ISO date string / Date. */
  cursor?: PlatformAuditCursor | Date;
  limit?: number;
  targetId?: string;
  targetType?: string;
}

export const encodeAuditCursor = (row: Pick<PlatformAuditLogItem, 'createdAt' | 'id'>): string =>
  `${row.createdAt.toISOString()}|${row.id}`;

export const parseAuditCursor = (
  cursor: PlatformAuditCursor | Date | undefined,
): { createdAt: Date; id?: string } | null => {
  if (!cursor) return null;
  if (cursor instanceof Date) return { createdAt: cursor };
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
      ipHash: params.ipHash ?? null,
      reason: params.reason ?? null,
      requestId: params.requestId ?? null,
      result: params.result,
      targetId: params.targetId ?? null,
      targetType: params.targetType,
      userAgent: params.userAgent ?? null,
    };

    const [row] = await this.db.insert(platformAuditLogs).values(values).returning();
    return row;
  };

  findById = async (id: string): Promise<PlatformAuditLogItem | undefined> => {
    return this.db.query.platformAuditLogs.findFirst({
      where: eq(platformAuditLogs.id, id),
    });
  };

  /**
   * Cursor pagination by (createdAt, id) descending.
   * Composite cursor prevents skipping same-millisecond rows.
   */
  list = async (
    params: ListPlatformAuditLogParams = {},
  ): Promise<{ items: PlatformAuditLogItem[]; nextCursor: string | null }> => {
    const limit = Math.min(params.limit ?? 50, 200);
    const conditions = [];

    if (params.actorUserId) {
      conditions.push(eq(platformAuditLogs.actorUserId, params.actorUserId));
    }
    if (params.targetType) {
      conditions.push(eq(platformAuditLogs.targetType, params.targetType));
    }
    if (params.targetId) {
      conditions.push(eq(platformAuditLogs.targetId, params.targetId));
    }

    const parsed = parseAuditCursor(params.cursor);
    if (parsed) {
      if (parsed.id) {
        // (createdAt, id) < (cursor.createdAt, cursor.id) in desc order:
        // createdAt < cursor OR (createdAt = cursor AND id < cursor.id)
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

    const rows = await this.db.query.platformAuditLogs.findMany({
      limit: limit + 1,
      orderBy: [desc(platformAuditLogs.createdAt), desc(platformAuditLogs.id)],
      where: conditions.length > 0 ? and(...conditions) : undefined,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeAuditCursor(last) : null;

    return { items, nextCursor };
  };
}

// silence unused sql import if tree-shaken poorly
void sql;

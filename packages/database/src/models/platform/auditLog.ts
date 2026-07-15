import { and, desc, eq, lt } from 'drizzle-orm';

import {
  type NewPlatformAuditLog,
  type PlatformAuditLogItem,
  platformAuditLogs,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { redactSensitive } from './redact';

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

export interface ListPlatformAuditLogParams {
  actorUserId?: string;
  cursor?: Date;
  limit?: number;
  targetId?: string;
  targetType?: string;
}

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
   * Cursor pagination by createdAt (descending). No unbounded export path.
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
    if (params.cursor) {
      conditions.push(lt(platformAuditLogs.createdAt, params.cursor));
    }

    const rows = await this.db.query.platformAuditLogs.findMany({
      limit: limit + 1,
      orderBy: [desc(platformAuditLogs.createdAt)],
      where: conditions.length > 0 ? and(...conditions) : undefined,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items.at(-1)?.createdAt?.toISOString() ?? null) : null;

    return { items, nextCursor };
  };
}

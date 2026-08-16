import { randomUUID } from 'node:crypto';

import type { SQL } from 'drizzle-orm';
import { and, count, desc, eq, gte, ilike, inArray, lt, ne, or, sql } from 'drizzle-orm';

import type {
  ContentModerationRecord,
  ContentModerationRecordListInput,
} from '@/types/platform/contentModeration';

import {
  type NewPlatformContentModerationRecord,
  platformContentModerationRecords,
} from '../../schemas/platform';
import { users } from '../../schemas/user';
import type { LobeChatDatabase, Transaction } from '../../type';

const RECORD_SELECT = {
  autoBanned: platformContentModerationRecords.autoBanned,
  categoryScores: platformContentModerationRecords.categoryScores,
  classifierLatencyMs: platformContentModerationRecords.classifierLatencyMs,
  createdAt: platformContentModerationRecords.createdAt,
  effectiveAction: platformContentModerationRecords.effectiveAction,
  effectiveModel: platformContentModerationRecords.effectiveModel,
  effectiveProvider: platformContentModerationRecords.effectiveProvider,
  enforced: platformContentModerationRecords.enforced,
  error: platformContentModerationRecords.error,
  hasFullPrompt: sql<boolean>`(${platformContentModerationRecords.promptFull} IS NOT NULL)`.mapWith(
    Boolean,
  ),
  id: platformContentModerationRecords.id,
  matchedRule: platformContentModerationRecords.matchedRule,
  messageId: platformContentModerationRecords.messageId,
  model: platformContentModerationRecords.model,
  notified: platformContentModerationRecords.notified,
  policyAction: platformContentModerationRecords.policyAction,
  promptExcerpt: platformContentModerationRecords.promptExcerpt,
  promptHash: platformContentModerationRecords.promptHash,
  provider: platformContentModerationRecords.provider,
  requestId: platformContentModerationRecords.requestId,
  requestKind: platformContentModerationRecords.requestKind,
  revealedAt: platformContentModerationRecords.revealedAt,
  revealedBy: platformContentModerationRecords.revealedBy,
  source: platformContentModerationRecords.source,
  thresholdSnapshot: platformContentModerationRecords.thresholdSnapshot,
  topCategory: platformContentModerationRecords.topCategory,
  topScore: platformContentModerationRecords.topScore,
  topicId: platformContentModerationRecords.topicId,
  userId: platformContentModerationRecords.userId,
  userSnapshot: platformContentModerationRecords.userSnapshot,
  violationCount: platformContentModerationRecords.violationCount,
};

const escapeLike = (value: string): string => value.replaceAll(/[%_\\]/g, '\\$&');

const likeContains = (value: string): string => `%${escapeLike(value)}%`;

export type ContentModerationRecordInsert = Omit<NewPlatformContentModerationRecord, 'id'> & {
  id?: string;
};

export interface ContentModerationTopUser {
  count: number;
  email?: string;
  fullName?: string;
  userId: string;
  username?: string;
}

/**
 * Content-moderation decision records. List/detail never select `prompt_full`.
 */
export class PlatformContentModerationRecordModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  insert = async (record: ContentModerationRecordInsert): Promise<ContentModerationRecord> => {
    const [row] = await this.db
      .insert(platformContentModerationRecords)
      .values({
        ...record,
        id: record.id ?? randomUUID(),
      })
      .returning(RECORD_SELECT);
    return row as ContentModerationRecord;
  };

  list = async (
    input: ContentModerationRecordListInput,
  ): Promise<{ items: ContentModerationRecord[]; total: number }> => {
    const conn = this.db as LobeChatDatabase;
    if (typeof conn.transaction === 'function') {
      return conn.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        return new PlatformContentModerationRecordModel(tx).listFromSnapshot(input);
      });
    }
    return this.listFromSnapshot(input);
  };

  getById = async (id: string): Promise<ContentModerationRecord | null> => {
    const [row] = await this.db
      .select(RECORD_SELECT)
      .from(platformContentModerationRecords)
      .where(eq(platformContentModerationRecords.id, id))
      .limit(1);
    return (row as ContentModerationRecord | undefined) ?? null;
  };

  getFullPrompt = async (id: string): Promise<string | null> => {
    const [row] = await this.db
      .select({ promptFull: platformContentModerationRecords.promptFull })
      .from(platformContentModerationRecords)
      .where(eq(platformContentModerationRecords.id, id))
      .limit(1);
    return row?.promptFull ?? null;
  };

  markRevealed = async (id: string, by: string): Promise<void> => {
    await this.db
      .update(platformContentModerationRecords)
      .set({
        revealedAt: new Date(),
        revealedBy: by,
      })
      .where(eq(platformContentModerationRecords.id, id));
  };

  deleteByIds = async (ids: string[]): Promise<number> => {
    if (ids.length === 0) return 0;
    if (ids.length > 200) {
      throw new Error('CONTENT_MODERATION_DELETE_LIMIT');
    }
    const deleted = await this.db
      .delete(platformContentModerationRecords)
      .where(inArray(platformContentModerationRecords.id, ids))
      .returning({ id: platformContentModerationRecords.id });
    return deleted.length;
  };

  /**
   * Windowed violation count used by auto-ban (design §3.5):
   * `effective_action ∈ (downgrade, block)`, optionally excluding cache hits,
   * and only rows after the most recent `auto_banned` record for that user.
   */
  countUserViolations = async (params: {
    excludeCache?: boolean;
    since: Date;
    userId: string;
  }): Promise<number> => {
    const excludeCache = params.excludeCache ?? true;
    const table = platformContentModerationRecords;
    const conditions: SQL[] = [
      eq(table.userId, params.userId),
      gte(table.createdAt, params.since),
      inArray(table.effectiveAction, ['downgrade', 'block']),
    ];
    if (excludeCache) conditions.push(ne(table.source, 'cache'));

    const [lastBan] = await this.db
      .select({ createdAt: table.createdAt })
      .from(table)
      .where(and(eq(table.userId, params.userId), eq(table.autoBanned, true)))
      .orderBy(desc(table.createdAt))
      .limit(1);
    if (lastBan) conditions.push(sql`${table.createdAt} > ${lastBan.createdAt}`);

    const [row] = await this.db
      .select({ value: count() })
      .from(table)
      .where(and(...conditions));
    return Number(row?.value ?? 0);
  };

  topUsers = async (params: {
    from: Date;
    limit: number;
    to: Date;
  }): Promise<ContentModerationTopUser[]> => {
    const table = platformContentModerationRecords;
    const total = sql<number>`COUNT(*)`.mapWith(Number);
    const rows = await this.db
      .select({
        count: total,
        email: users.email,
        fullName: users.fullName,
        userId: table.userId,
        username: users.username,
      })
      .from(table)
      .leftJoin(users, eq(table.userId, users.id))
      .where(
        and(
          gte(table.createdAt, params.from),
          lt(table.createdAt, params.to),
          ne(table.policyAction, 'ignore'),
          sql`${table.userId} IS NOT NULL`,
        ),
      )
      .groupBy(table.userId, users.email, users.username, users.fullName)
      .orderBy(desc(total))
      .limit(params.limit);

    return rows
      .filter((row): row is typeof row & { userId: string } => Boolean(row.userId))
      .map((row) => ({
        count: row.count,
        email: row.email ?? undefined,
        fullName: row.fullName ?? undefined,
        userId: row.userId,
        username: row.username ?? undefined,
      }));
  };

  markAutoBanned = async (id: string): Promise<void> => {
    await this.db
      .update(platformContentModerationRecords)
      .set({ autoBanned: true })
      .where(eq(platformContentModerationRecords.id, id));
  };

  markNotified = async (id: string): Promise<void> => {
    await this.db
      .update(platformContentModerationRecords)
      .set({ notified: true })
      .where(eq(platformContentModerationRecords.id, id));
  };

  /**
   * Hit rows (`policy_action ≠ ignore` OR `effective_action = 'error'`) expire after
   * `hitRetentionDays`; everything else after `nonHitRetentionDays`. Bounded to `limit`.
   */
  purgeExpired = async (params: {
    hitRetentionDays: number;
    limit?: number;
    nonHitRetentionDays: number;
  }): Promise<number> => {
    const limit = params.limit ?? 5000;
    const table = platformContentModerationRecords;
    const deleted = await this.db.execute(sql`
      DELETE FROM ${table}
      WHERE id IN (
        SELECT id FROM ${table}
        WHERE (
          ((${table.policyAction} <> 'ignore' OR ${table.effectiveAction} = 'error')
            AND ${table.createdAt} < now() - (${params.hitRetentionDays} * interval '1 day'))
          OR
          (${table.policyAction} = 'ignore' AND ${table.effectiveAction} <> 'error'
            AND ${table.createdAt} < now() - (${params.nonHitRetentionDays} * interval '1 day'))
        )
        LIMIT ${limit}
      )
    `);
    const countDeleted =
      typeof deleted === 'object' && deleted && 'rowCount' in deleted
        ? Number((deleted as { rowCount?: number }).rowCount ?? 0)
        : 0;
    return countDeleted;
  };

  private listFromSnapshot = async (
    input: ContentModerationRecordListInput,
  ): Promise<{ items: ContentModerationRecord[]; total: number }> => {
    const table = platformContentModerationRecords;
    const conditions = this.buildListConditions(input);
    const filterWhere = conditions.length > 0 ? and(...conditions) : undefined;
    const needsUserJoin = Boolean(input.userQuery?.trim());

    const listQuery = needsUserJoin
      ? this.db
          .select(RECORD_SELECT)
          .from(table)
          .innerJoin(users, eq(table.userId, users.id))
          .where(filterWhere)
          .orderBy(desc(table.createdAt), desc(table.id))
          .limit(input.limit)
          .offset(input.offset)
      : this.db
          .select(RECORD_SELECT)
          .from(table)
          .where(filterWhere)
          .orderBy(desc(table.createdAt), desc(table.id))
          .limit(input.limit)
          .offset(input.offset);

    const countQuery = needsUserJoin
      ? this.db
          .select({ value: count() })
          .from(table)
          .innerJoin(users, eq(table.userId, users.id))
          .where(filterWhere)
      : this.db.select({ value: count() }).from(table).where(filterWhere);

    const [rows, countRows] = await Promise.all([listQuery, countQuery]);

    return {
      items: rows as ContentModerationRecord[],
      total: Number(countRows[0]?.value ?? 0),
    };
  };

  private buildListConditions = (input: ContentModerationRecordListInput): SQL[] => {
    const table = platformContentModerationRecords;
    const conditions: SQL[] = [];

    if (input.actions?.length) {
      conditions.push(inArray(table.effectiveAction, input.actions));
    }
    if (input.policyActions?.length) {
      conditions.push(inArray(table.policyAction, input.policyActions));
    }
    if (input.categories?.length) {
      conditions.push(inArray(table.topCategory, input.categories));
    }
    if (input.sources?.length) {
      conditions.push(inArray(table.source, input.sources));
    }
    if (input.requestKinds?.length) {
      conditions.push(inArray(table.requestKind, input.requestKinds));
    }
    if (input.userId) conditions.push(eq(table.userId, input.userId));
    if (input.from) conditions.push(gte(table.createdAt, input.from));
    if (input.to) conditions.push(lt(table.createdAt, input.to));

    if (!input.includeNonHits) {
      conditions.push(ne(table.policyAction, 'ignore'));
    }

    const search = input.search?.trim();
    if (search) {
      const pattern = likeContains(search);
      conditions.push(or(ilike(table.requestId, pattern), ilike(table.promptExcerpt, pattern))!);
    }

    const userQuery = input.userQuery?.trim();
    if (userQuery) {
      const pattern = likeContains(userQuery);
      conditions.push(
        or(
          ilike(users.email, pattern),
          ilike(users.username, pattern),
          ilike(users.fullName, pattern),
        )!,
      );
    }

    return conditions;
  };
}

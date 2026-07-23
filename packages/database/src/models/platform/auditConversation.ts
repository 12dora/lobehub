/**
 * Unscoped admin-only conversation / message evidence reader for platform audit.
 *
 * - No user-scoped constructor: requires explicit `userId` (and `userId+topicId` for messages).
 * - `db.select()` only (no relational `db.query`).
 * - Keyset pagination; whitelisted evidence fields only.
 * - Does not apply credential masking — service layer owns content policy + masking.
 */

import { and, desc, eq, gte, ilike, lt, or, type SQL, sql } from 'drizzle-orm';

import { messages } from '../../schemas/message';
import { sessions } from '../../schemas/session';
import { topics } from '../../schemas/topic';
import { users } from '../../schemas/user';
import type { LobeChatDatabase, Transaction } from '../../type';

const clampListLimit = (limit?: number): number =>
  Math.min(Math.max(Math.floor(limit ?? 50), 1), 200);

const encodeCursor = (row: { createdAt: Date; id: string }): string =>
  `${row.createdAt.toISOString()}|${row.id}`;

const parseCursor = (cursor: string | undefined): { createdAt: Date; id: string } | null => {
  if (!cursor?.includes('|')) return null;
  const [iso, id] = cursor.split('|');
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
};

const escapeLike = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

export interface PlatformAuditConversationTopicListParams {
  /** Composite cursor `${createdAt.toISOString()}|${id}` (desc). */
  cursor?: string;
  /** Inclusive lower bound on topic.createdAt. */
  from?: Date;
  /** Clamped 1..200 (default 50). */
  limit?: number;
  /** Title-only prefix / contains search (already normalized by caller). */
  q?: string;
  /** Exclusive upper bound on topic.createdAt. */
  to?: Date;
  /** Required — unscoped scans are not permitted. */
  userId: string;
}

export interface PlatformAuditConversationTopicItem {
  agentId: string | null;
  createdAt: Date;
  description: string | null;
  id: string;
  model: string | null;
  provider: string | null;
  sessionId: string | null;
  status: string | null;
  title: string | null;
  updatedAt: Date;
  userId: string;
}

export interface PlatformAuditConversationTopicDetail extends PlatformAuditConversationTopicItem {
  /** Present only when the service layer opts into content fields. */
  content?: string | null;
  editorData?: unknown;
  historySummary?: string | null;
}

export interface PlatformAuditConversationMessageListParams {
  cursor?: string;
  /** Inclusive lower bound on message.createdAt. */
  from?: Date;
  limit?: number;
  /** Exclusive upper bound on message.createdAt. */
  to?: Date;
  /** Required with userId. */
  topicId: string;
  /** Required. */
  userId: string;
}

export interface PlatformAuditConversationMessageItem {
  agentId: string | null;
  content: string | null;
  createdAt: Date;
  editorData: unknown;
  error: unknown;
  id: string;
  model: string | null;
  parentId: string | null;
  provider: string | null;
  role: string;
  sessionId: string | null;
  topicId: string | null;
  updatedAt: Date;
  userId: string;
}

/** List projection omits large body fields for performance. */
export interface PlatformAuditConversationMessageListItem {
  agentId: string | null;
  createdAt: Date;
  hasContent: boolean;
  id: string;
  model: string | null;
  parentId: string | null;
  provider: string | null;
  role: string;
  sessionId: string | null;
  topicId: string | null;
  updatedAt: Date;
  userId: string;
}

export interface PlatformAuditUserSearchParams {
  cursor?: string;
  limit?: number;
  /** Normalized (trim/lower) search; applied as prefix on email/username/id. */
  q: string;
}

export interface PlatformAuditUserSearchItem {
  createdAt: Date;
  email: string | null;
  fullName: string | null;
  id: string;
  lastActiveAt: Date | null;
  username: string | null;
}

export interface PlatformAuditUserSummary {
  createdAt: Date;
  email: string | null;
  fullName: string | null;
  id: string;
  lastActiveAt: Date | null;
  messageCount: number;
  topicCount: number;
  username: string | null;
}

export interface PlatformAuditUserTimelineParams {
  cursor?: string;
  from?: Date;
  limit?: number;
  to?: Date;
  userId: string;
}

export interface PlatformAuditUserTimelineItem {
  createdAt: Date;
  id: string;
  kind: 'topic' | 'session';
  sessionId: string | null;
  title: string | null;
  topicId: string | null;
  updatedAt: Date;
}

/**
 * Admin-only unscoped conversation evidence model.
 * Always requires explicit user scope at the method boundary.
 */
export class PlatformAuditConversationModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  listTopics = async (
    params: PlatformAuditConversationTopicListParams,
  ): Promise<{ items: PlatformAuditConversationTopicItem[]; nextCursor: string | null }> => {
    if (!params.userId) throw new Error('userId is required for platform audit conversation list');

    const limit = clampListLimit(params.limit);
    const conditions: SQL[] = [eq(topics.userId, params.userId)];

    if (params.from) conditions.push(gte(topics.createdAt, params.from));
    if (params.to) conditions.push(lt(topics.createdAt, params.to));
    if (params.q) {
      // Title-only; escaped for ILIKE. Does not search message body.
      const pattern = `%${escapeLike(params.q)}%`;
      conditions.push(ilike(topics.title, pattern));
    }

    const parsed = parseCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(topics.createdAt, parsed.createdAt),
          and(eq(topics.createdAt, parsed.createdAt), lt(topics.id, parsed.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        agentId: topics.agentId,
        createdAt: topics.createdAt,
        description: topics.description,
        id: topics.id,
        model: topics.model,
        provider: topics.provider,
        sessionId: topics.sessionId,
        status: topics.status,
        title: topics.title,
        updatedAt: topics.updatedAt,
        userId: topics.userId,
      })
      .from(topics)
      .where(and(...conditions))
      .orderBy(desc(topics.createdAt), desc(topics.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  };

  getTopic = async (params: {
    topicId: string;
    userId: string;
  }): Promise<PlatformAuditConversationTopicDetail | undefined> => {
    if (!params.userId || !params.topicId) {
      throw new Error('userId and topicId are required for platform audit conversation get');
    }

    const [row] = await this.db
      .select({
        agentId: topics.agentId,
        content: topics.content,
        createdAt: topics.createdAt,
        description: topics.description,
        editorData: topics.editorData,
        historySummary: topics.historySummary,
        id: topics.id,
        model: topics.model,
        provider: topics.provider,
        sessionId: topics.sessionId,
        status: topics.status,
        title: topics.title,
        updatedAt: topics.updatedAt,
        userId: topics.userId,
      })
      .from(topics)
      .where(and(eq(topics.userId, params.userId), eq(topics.id, params.topicId)))
      .limit(1);

    return row;
  };

  listMessages = async (
    params: PlatformAuditConversationMessageListParams,
  ): Promise<{
    items: PlatformAuditConversationMessageListItem[];
    nextCursor: string | null;
  }> => {
    if (!params.userId || !params.topicId) {
      throw new Error('userId and topicId are required for platform audit message list');
    }

    const limit = clampListLimit(params.limit);
    const conditions: SQL[] = [
      eq(messages.userId, params.userId),
      eq(messages.topicId, params.topicId),
    ];

    if (params.from) conditions.push(gte(messages.createdAt, params.from));
    if (params.to) conditions.push(lt(messages.createdAt, params.to));

    const parsed = parseCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(messages.createdAt, parsed.createdAt),
          and(eq(messages.createdAt, parsed.createdAt), lt(messages.id, parsed.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        agentId: messages.agentId,
        content: messages.content,
        createdAt: messages.createdAt,
        id: messages.id,
        model: messages.model,
        parentId: messages.parentId,
        provider: messages.provider,
        role: messages.role,
        sessionId: messages.sessionId,
        topicId: messages.topicId,
        updatedAt: messages.updatedAt,
        userId: messages.userId,
      })
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const items: PlatformAuditConversationMessageListItem[] = slice.map((row) => ({
      agentId: row.agentId,
      createdAt: row.createdAt,
      hasContent: Boolean(row.content && row.content.length > 0),
      id: row.id,
      model: row.model,
      parentId: row.parentId,
      provider: row.provider,
      role: row.role,
      sessionId: row.sessionId,
      topicId: row.topicId,
      updatedAt: row.updatedAt,
      userId: row.userId,
    }));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  };

  /**
   * Full message evidence for a topic (detail / export path).
   * Still requires userId+topicId; keyset-paginated.
   */
  listMessageDetails = async (
    params: PlatformAuditConversationMessageListParams,
  ): Promise<{ items: PlatformAuditConversationMessageItem[]; nextCursor: string | null }> => {
    if (!params.userId || !params.topicId) {
      throw new Error('userId and topicId are required for platform audit message detail list');
    }

    const limit = clampListLimit(params.limit);
    const conditions: SQL[] = [
      eq(messages.userId, params.userId),
      eq(messages.topicId, params.topicId),
    ];

    if (params.from) conditions.push(gte(messages.createdAt, params.from));
    if (params.to) conditions.push(lt(messages.createdAt, params.to));

    const parsed = parseCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(messages.createdAt, parsed.createdAt),
          and(eq(messages.createdAt, parsed.createdAt), lt(messages.id, parsed.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        agentId: messages.agentId,
        content: messages.content,
        createdAt: messages.createdAt,
        editorData: messages.editorData,
        error: messages.error,
        id: messages.id,
        model: messages.model,
        parentId: messages.parentId,
        provider: messages.provider,
        role: messages.role,
        sessionId: messages.sessionId,
        topicId: messages.topicId,
        updatedAt: messages.updatedAt,
        userId: messages.userId,
      })
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  };

  getMessage = async (params: {
    messageId: string;
    userId: string;
  }): Promise<PlatformAuditConversationMessageItem | undefined> => {
    if (!params.userId || !params.messageId) {
      throw new Error('userId and messageId are required');
    }

    const [row] = await this.db
      .select({
        agentId: messages.agentId,
        content: messages.content,
        createdAt: messages.createdAt,
        editorData: messages.editorData,
        error: messages.error,
        id: messages.id,
        model: messages.model,
        parentId: messages.parentId,
        provider: messages.provider,
        role: messages.role,
        sessionId: messages.sessionId,
        topicId: messages.topicId,
        updatedAt: messages.updatedAt,
        userId: messages.userId,
      })
      .from(messages)
      .where(and(eq(messages.userId, params.userId), eq(messages.id, params.messageId)))
      .limit(1);

    return row;
  };

  searchUsers = async (
    params: PlatformAuditUserSearchParams,
  ): Promise<{ items: PlatformAuditUserSearchItem[]; nextCursor: string | null }> => {
    if (!params.q) throw new Error('q is required for platform audit user search');

    const limit = clampListLimit(params.limit);
    const prefix = `${escapeLike(params.q)}%`;
    const conditions: SQL[] = [
      or(
        ilike(users.email, prefix),
        ilike(users.username, prefix),
        ilike(users.id, prefix),
        ilike(users.fullName, prefix),
      )!,
    ];

    const parsed = parseCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(users.createdAt, parsed.createdAt),
          and(eq(users.createdAt, parsed.createdAt), lt(users.id, parsed.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        createdAt: users.createdAt,
        email: users.email,
        fullName: users.fullName,
        id: users.id,
        lastActiveAt: users.lastActiveAt,
        username: users.username,
      })
      .from(users)
      .where(and(...conditions))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  };

  getUserSummary = async (userId: string): Promise<PlatformAuditUserSummary | undefined> => {
    if (!userId) throw new Error('userId is required');

    const [user] = await this.db
      .select({
        createdAt: users.createdAt,
        email: users.email,
        fullName: users.fullName,
        id: users.id,
        lastActiveAt: users.lastActiveAt,
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return undefined;

    const [[topicCountRow], [messageCountRow]] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(topics)
        .where(eq(topics.userId, userId)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(eq(messages.userId, userId)),
    ]);

    return {
      ...user,
      messageCount: Number(messageCountRow?.count ?? 0),
      topicCount: Number(topicCountRow?.count ?? 0),
    };
  };

  /**
   * User activity timeline: topics (conversations) newest first.
   * Sessions can be joined later; topics are the primary conversation unit.
   */
  listUserTimeline = async (
    params: PlatformAuditUserTimelineParams,
  ): Promise<{ items: PlatformAuditUserTimelineItem[]; nextCursor: string | null }> => {
    if (!params.userId) throw new Error('userId is required for timeline');

    const limit = clampListLimit(params.limit);
    const conditions: SQL[] = [eq(topics.userId, params.userId)];
    if (params.from) conditions.push(gte(topics.createdAt, params.from));
    if (params.to) conditions.push(lt(topics.createdAt, params.to));

    const parsed = parseCursor(params.cursor);
    if (parsed) {
      conditions.push(
        or(
          lt(topics.createdAt, parsed.createdAt),
          and(eq(topics.createdAt, parsed.createdAt), lt(topics.id, parsed.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        createdAt: topics.createdAt,
        id: topics.id,
        sessionId: topics.sessionId,
        title: topics.title,
        updatedAt: topics.updatedAt,
      })
      .from(topics)
      .where(and(...conditions))
      .orderBy(desc(topics.createdAt), desc(topics.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const items: PlatformAuditUserTimelineItem[] = slice.map((row) => ({
      createdAt: row.createdAt,
      id: row.id,
      kind: 'topic' as const,
      sessionId: row.sessionId,
      title: row.title,
      topicId: row.id,
      updatedAt: row.updatedAt,
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  };

  /** Exists check that still requires userId so cross-user topic ids cannot leak. */
  topicExistsForUser = async (userId: string, topicId: string): Promise<boolean> => {
    const [row] = await this.db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.userId, userId), eq(topics.id, topicId)))
      .limit(1);
    return Boolean(row);
  };

  /** Optional session ownership check for scope validation. */
  sessionExistsForUser = async (userId: string, sessionId: string): Promise<boolean> => {
    const [row] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
      .limit(1);
    return Boolean(row);
  };
}

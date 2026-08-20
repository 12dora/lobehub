import type { CreateThreadParams, UpdateThreadParams } from '@lobechat/types';
import { RequestTrigger, ThreadStatus } from '@lobechat/types';
import { and, desc, eq, inArray, isNull, not, notExists, or, sql } from 'drizzle-orm';

import type { ThreadItem } from '../schemas';
import { agentOperations, messages, threads, topics } from '../schemas';
import type { LobeChatDatabase, Transaction } from '../type';
import { buildWorkspacePayload, buildWorkspaceWhere } from '../utils/workspace';

/**
 * Per-thread subagent metrics, derived from the child messages at read time
 * (single source of truth = the messages, not a denormalized write). Mirrors
 * `aggregateSubagentMetrics` in the app: SUM of assistant `usage.totalTokens`
 * (prefer the promoted `usage` column, fall back to legacy `metadata.usage`),
 * COUNT of `role='tool'`, and a pinned model. Folded onto `metadata.*` so the
 * subagent inspector chip can read it without hydrating the child messages.
 */
const subagentMetricColumns = {
  _model: sql<
    string | null
  >`MAX(CASE WHEN ${messages.role} = 'assistant' THEN ${messages.model} END)`.as('_sa_model'),
  _totalToolCalls: sql<number>`COUNT(CASE WHEN ${messages.role} = 'tool' THEN 1 END)`.as(
    '_sa_tool_calls',
  ),
  _totalTokens:
    sql<number>`COALESCE(SUM(CASE WHEN ${messages.role} = 'assistant' THEN (COALESCE(${messages.usage}, ${messages.metadata} -> 'usage') ->> 'totalTokens')::numeric END), 0)`.as(
      '_sa_total_tokens',
    ),
};

type ThreadMetricRow = ThreadItem & {
  _model: string | null;
  _totalToolCalls: number | string;
  _totalTokens: number | string;
};

/** Fold the SQL-derived metric columns onto `metadata` and drop the temp keys. */
const foldSubagentMetrics = (rows: ThreadMetricRow[]): ThreadItem[] =>
  rows.map(({ _model, _totalToolCalls, _totalTokens, ...thread }) => {
    const totalToolCalls = Number(_totalToolCalls);
    const totalTokens = Number(_totalTokens);
    return {
      ...thread,
      metadata: {
        ...thread.metadata,
        ...(totalToolCalls > 0 && { totalToolCalls }),
        ...(totalTokens > 0 && { totalTokens }),
        ...(_model && { model: _model }),
      },
    };
  });

const queryColumns = {
  agentId: threads.agentId,
  createdAt: threads.createdAt,
  groupId: threads.groupId,
  id: threads.id,
  metadata: threads.metadata,
  parentThreadId: threads.parentThreadId,
  sourceMessageId: threads.sourceMessageId,
  status: threads.status,
  title: threads.title,
  topicId: threads.topicId,
  type: threads.type,
  updatedAt: threads.updatedAt,
};

export class ThreadModel {
  private userId: string;
  private db: LobeChatDatabase;
  private workspaceId?: string;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.userId = userId;
    this.db = db;
    this.workspaceId = workspaceId;
  }

  private ownership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, threads);

  private topicOwnership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, topics);

  private assertOwnedTopic = async (
    topicId: string,
    db: LobeChatDatabase | Transaction = this.db,
  ): Promise<void> => {
    const [row] = await db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.id, topicId), this.topicOwnership()))
      .limit(1);

    if (!row) throw new Error('Topic not found');
  };

  private static readonly UPDATE_SQL_KEYS = [
    'content',
    'lastActiveAt',
    'metadata',
    'status',
    'title',
  ] as const satisfies ReadonlyArray<keyof UpdateThreadParams>;

  /**
   * Parent topic must be a group topic or a visible local agent. A non-null
   * `threads.agentId` must also be in the visible set.
   */
  private visibleThreadPredicate = (visibleAgentIds: string[]) => {
    const topicVisible =
      visibleAgentIds.length > 0
        ? or(not(isNull(topics.groupId)), inArray(topics.agentId, visibleAgentIds))
        : not(isNull(topics.groupId));
    const threadAgentVisible =
      visibleAgentIds.length > 0
        ? or(isNull(threads.agentId), inArray(threads.agentId, visibleAgentIds))
        : isNull(threads.agentId);
    return and(topicVisible, threadAgentVisible);
  };

  create = async (params: CreateThreadParams, trx?: Transaction) => {
    // Always runs inside a transaction (caller's or our own), so the narrower
    // type keeps drizzle's insert().returning() overload unambiguous.
    const run = async (db: Transaction) => {
      await this.assertOwnedTopic(params.topicId, db);

      const [result] = await db
        .insert(threads)
        .values(
          buildWorkspacePayload(
            { userId: this.userId, workspaceId: this.workspaceId },
            {
              agentId: params.agentId,
              groupId: params.groupId,
              id: params.id,
              metadata: params.metadata,
              parentThreadId: params.parentThreadId,
              sourceMessageId: params.sourceMessageId,
              status: params.status ?? ThreadStatus.Active,
              title: params.title,
              topicId: params.topicId,
              type: params.type,
            },
          ),
        )
        .onConflictDoNothing()
        .returning();

      return result;
    };

    if (trx) return run(trx);
    return this.db.transaction((tx) => run(tx));
  };

  delete = async (id: string) => {
    return this.db.delete(threads).where(and(eq(threads.id, id), this.ownership()));
  };

  deleteAll = async () => {
    return this.db.delete(threads).where(this.ownership());
  };

  query = async (params?: { visibleAgentIds?: string[] }) => {
    if (!params?.visibleAgentIds) {
      const data = await this.db
        .select(queryColumns)
        .from(threads)
        .where(this.ownership())
        .orderBy(desc(threads.updatedAt));

      return data as ThreadItem[];
    }

    const data = await this.db
      .select(queryColumns)
      .from(threads)
      .innerJoin(topics, eq(threads.topicId, topics.id))
      .where(and(this.ownership(), this.visibleThreadPredicate(params.visibleAgentIds)))
      .orderBy(desc(threads.updatedAt));

    return data as ThreadItem[];
  };

  queryByTopicId = async (topicId: string) => {
    // LEFT JOIN + GROUP BY threads.id (PK ⇒ Postgres lets us select the plain
    // thread columns alongside the per-thread aggregates). `threadId` join
    // naturally scopes to in-thread rows, excluding the spawning parent.
    const data = await this.db
      .select({ ...queryColumns, ...subagentMetricColumns })
      .from(threads)
      .leftJoin(messages, eq(messages.threadId, threads.id))
      .where(
        and(
          eq(threads.topicId, topicId),
          this.ownership(),
          // NOTICE:
          // Agent Signal self-iteration runs create isolation threads to keep
          // internal memory/skill traces out of the main chat transcript.
          // Those traces are persisted for audit/debugging through
          // `agent_operations.trigger = agent_signal`, but should not appear as
          // user-facing sub-agent attachments in the topic thread list.
          notExists(
            this.db
              .select({ id: agentOperations.id })
              .from(agentOperations)
              .where(
                and(
                  eq(agentOperations.threadId, threads.id),
                  eq(agentOperations.trigger, RequestTrigger.AgentSignal),
                ),
              ),
          ),
        ),
      )
      .groupBy(threads.id)
      .orderBy(desc(threads.updatedAt));

    return foldSubagentMetrics(data as ThreadMetricRow[]);
  };

  findById = async (id: string) => {
    return this.db.query.threads.findFirst({
      where: and(eq(threads.id, id), this.ownership()),
    });
  };

  update = async (id: string, value: UpdateThreadParams) => {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ThreadModel.UPDATE_SQL_KEYS) {
      if (value[key] !== undefined) {
        patch[key] = value[key];
      }
    }

    return this.db
      .update(threads)
      .set(patch as Partial<ThreadItem>)
      .where(and(eq(threads.id, id), this.ownership()));
  };
}

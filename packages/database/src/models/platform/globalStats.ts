/**
 * Platform-wide (global) analytics aggregation — no ownership / workspace scope.
 *
 * Mirrors the business filters of MessageModel / TopicModel / AgentModel /
 * AgentOperationModel / UsageRecordService stats methods, without
 * `buildWorkspaceWhere`. Used only by admin.stats (platform_stats:read:all).
 */
import { INBOX_SESSION_ID } from '@lobechat/const';
import type { AgentRankItem, ModelRankItem, TopicRankItem } from '@lobechat/types';
import type { HeatmapsProps } from '@lobehub/charts';
import dayjs from 'dayjs';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import type { MessageMetadata } from '@/types/message';
import type { UsageLog, UsageRecordItem } from '@/types/usage/usageRecord';
import { today } from '@/utils/time';

import { agents, messages, topics, users } from '../../schemas';
import { agentOperations } from '../../schemas/agentOperations';
import type { LobeChatDatabase } from '../../type';
import { genEndDateWhere, genRangeWhere, genStartDateWhere, genWhere } from '../../utils/genWhere';
import { normalizeInboxAgentMeta } from '../../utils/inboxAgent';

/**
 * Hard safety cap for uncapped {@link PlatformGlobalStatsModel.findByDateRange} /
 * {@link PlatformGlobalStatsModel.findByMonth} drains. Prevents unbounded in-memory
 * materialization of raw message rows (admin OOM risk). Prefer keyset paging via
 * findByDateRangePage / findByMonthPage for large ranges; charts use findAndGroupByDay.
 */
export const MAX_USAGE_DETAIL_ROWS = 20000;

/** Usage row with platform-global user display name (join users). */
export type GlobalUsageRecordItem = UsageRecordItem & { userDisplay: string };

export type GlobalUsageLog = Omit<UsageLog, 'records'> & {
  records: GlobalUsageRecordItem[];
};

export type GlobalStatsTotals = {
  agents: number;
  messages: number;
  topics: number;
  /** Users active within the last `activeDays` (by lastActiveAt). */
  usersActive: number;
  usersTotal: number;
};

// Heatmap intensity buckets. The message heatmap keys off an absolute count (one level per
// HEATMAP_MESSAGES_PER_LEVEL messages); the token heatmap scales relative to the busiest day.
// Both clamp to MAX_HEATMAP_LEVEL — the two formulas are intentionally different.
const MAX_HEATMAP_LEVEL = 4;
const HEATMAP_MESSAGES_PER_LEVEL = 5;

const userDisplaySql = sql<string>`COALESCE(NULLIF(TRIM(${users.fullName}), ''), NULLIF(TRIM(${users.username}), ''), NULLIF(TRIM(${users.email}), ''), ${users.id})`;

export class PlatformGlobalStatsModel {
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  countUsers = async (params?: {
    activeDays?: number;
  }): Promise<{
    active: number;
    total: number;
  }> => {
    const activeDays = params?.activeDays ?? 30;
    const activeSince = dayjs().subtract(activeDays, 'day').toDate();

    const [totalRow] = await this.db.select({ count: count() }).from(users);
    const [activeRow] = await this.db
      .select({ count: count() })
      .from(users)
      .where(and(isNotNull(users.lastActiveAt), gte(users.lastActiveAt, activeSince)));

    return {
      active: activeRow?.count ?? 0,
      total: totalRow?.count ?? 0,
    };
  };

  countMessages = async (params?: {
    endDate?: string;
    range?: [string, string];
    role?: string;
    startDate?: string;
  }): Promise<number> => {
    const result = await this.db
      .select({ count: count(messages.id) })
      .from(messages)
      .where(
        genWhere([
          params?.role ? eq(messages.role, params.role) : undefined,
          params?.range
            ? genRangeWhere(params.range, messages.createdAt, (date) => date.toDate())
            : undefined,
          params?.endDate
            ? genEndDateWhere(params.endDate, messages.createdAt, (date) => date.toDate())
            : undefined,
          params?.startDate
            ? genStartDateWhere(params.startDate, messages.createdAt, (date) => date.toDate())
            : undefined,
        ]),
      );

    return result[0]?.count ?? 0;
  };

  countTopics = async (params?: {
    endDate?: string;
    range?: [string, string];
    startDate?: string;
  }): Promise<number> => {
    const result = await this.db
      .select({ count: count(topics.id) })
      .from(topics)
      .where(
        genWhere([
          params?.range
            ? genRangeWhere(params.range, topics.createdAt, (date) => date.toDate())
            : undefined,
          params?.endDate
            ? genEndDateWhere(params.endDate, topics.createdAt, (date) => date.toDate())
            : undefined,
          params?.startDate
            ? genStartDateWhere(params.startDate, topics.createdAt, (date) => date.toDate())
            : undefined,
        ]),
      );

    return result[0]?.count ?? 0;
  };

  countAgents = async (params?: {
    endDate?: string;
    range?: [string, string];
    startDate?: string;
  }): Promise<number> => {
    // Align with AgentModel.countAgents: non-virtual (false or null legacy).
    const result = await this.db
      .select({ count: count() })
      .from(agents)
      .where(
        genWhere([
          or(eq(agents.virtual, false), isNull(agents.virtual)),
          params?.range
            ? genRangeWhere(params.range, agents.createdAt, (date) => date.toDate())
            : undefined,
          params?.endDate
            ? genEndDateWhere(params.endDate, agents.createdAt, (date) => date.toDate())
            : undefined,
          params?.startDate
            ? genStartDateWhere(params.startDate, agents.createdAt, (date) => date.toDate())
            : undefined,
        ]),
      );

    return result[0]?.count ?? 0;
  };

  totals = async (params?: { activeDays?: number }): Promise<GlobalStatsTotals> => {
    const [usersCount, messagesCount, topicsCount, agentsCount] = await Promise.all([
      this.countUsers(params),
      this.countMessages(),
      this.countTopics(),
      this.countAgents(),
    ]);

    return {
      agents: agentsCount,
      messages: messagesCount,
      topics: topicsCount,
      usersActive: usersCount.active,
      usersTotal: usersCount.total,
    };
  };

  rankModels = async (limit: number = 10): Promise<ModelRankItem[]> => {
    return this.db
      .select({
        count: count(messages.id).as('count'),
        id: messages.model,
      })
      .from(messages)
      .where(isNotNull(messages.model))
      .having(({ count: c }) => gt(c, 0))
      .groupBy(messages.model)
      .orderBy(desc(sql`count`), asc(messages.model))
      .limit(limit) as Promise<ModelRankItem[]>;
  };

  rankAgents = async (limit: number = 10): Promise<AgentRankItem[]> => {
    const rows = await this.db
      .select({
        avatar: agents.avatar,
        backgroundColor: agents.backgroundColor,
        count: count(topics.id).as('count'),
        id: agents.id,
        slug: agents.slug,
        title: agents.title,
      })
      .from(agents)
      .leftJoin(topics, eq(topics.agentId, agents.id))
      .where(or(eq(agents.slug, INBOX_SESSION_ID), ne(agents.virtual, true)))
      .groupBy(agents.id)
      .having(({ count: c }) => gt(c, 0))
      .orderBy(desc(sql`count`))
      .limit(limit);

    return rows.map(({ slug, ...row }) => normalizeInboxAgentMeta(row, { slug }));
  };

  rankTopics = async (limit: number = 10): Promise<TopicRankItem[]> => {
    return this.db
      .select({
        agentId: topics.agentId,
        count: count(messages.id).as('count'),
        id: topics.id,
        title: topics.title,
      })
      .from(topics)
      .leftJoin(messages, eq(topics.id, messages.topicId))
      .groupBy(topics.id)
      .orderBy(desc(sql`count`))
      .having(({ count: c }) => gt(c, 0))
      .limit(limit);
  };

  getHeatmaps = async (): Promise<HeatmapsProps['data']> => {
    const startDate = today().subtract(1, 'year').startOf('day');
    const endDate = today().endOf('day');

    const result = await this.db
      .select({
        count: count(messages.id),
        date: sql`DATE(${messages.createdAt})`.as('heatmaps_date'),
      })
      .from(messages)
      .where(
        genWhere([
          genRangeWhere(
            [startDate.format('YYYY-MM-DD'), endDate.add(1, 'day').format('YYYY-MM-DD')],
            messages.createdAt,
            (date) => date.toDate(),
          ),
        ]),
      )
      .groupBy(sql`heatmaps_date`)
      .orderBy(desc(sql`heatmaps_date`));

    const heatmapData: HeatmapsProps['data'] = [];
    let currentDate = startDate.clone();

    const dateCountMap = new Map<string, number>();
    for (const item of result) {
      if (item?.date) {
        const dateStr = dayjs(item.date as string).format('YYYY-MM-DD');
        dateCountMap.set(dateStr, item.count);
      }
    }

    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, 'day')) {
      const formattedDate = currentDate.format('YYYY-MM-DD');
      const dayCount = dateCountMap.get(formattedDate) || 0;

      const levelCount = dayCount > 0 ? Math.ceil(dayCount / HEATMAP_MESSAGES_PER_LEVEL) : 0;
      const level = Math.min(MAX_HEATMAP_LEVEL, levelCount);

      heatmapData.push({
        count: dayCount,
        date: formattedDate,
        level,
      });

      currentDate = currentDate.add(1, 'day');
    }

    return heatmapData;
  };

  getTokenHeatmaps = async (): Promise<HeatmapsProps['data']> => {
    const startDate = today().subtract(1, 'year').startOf('day');
    const endDate = today().endOf('day');

    const result = await this.db
      .select({
        date: sql`DATE(${messages.createdAt})`.as('heatmaps_date'),
        tokens:
          sql<number>`COALESCE(SUM((COALESCE(${messages.usage}, ${messages.metadata}->'usage')->>'totalTokens')::numeric), 0)`.mapWith(
            Number,
          ),
      })
      .from(messages)
      .where(
        genWhere([
          eq(messages.role, 'assistant'),
          genRangeWhere(
            [startDate.format('YYYY-MM-DD'), endDate.add(1, 'day').format('YYYY-MM-DD')],
            messages.createdAt,
            (date) => date.toDate(),
          ),
        ]),
      )
      .groupBy(sql`heatmaps_date`)
      .orderBy(desc(sql`heatmaps_date`));

    const dateTokenMap = new Map<string, number>();
    let maxTokens = 0;
    for (const item of result) {
      if (item?.date) {
        const dateStr = dayjs(item.date as string).format('YYYY-MM-DD');
        const tokens = item.tokens || 0;
        dateTokenMap.set(dateStr, tokens);
        if (tokens > maxTokens) maxTokens = tokens;
      }
    }

    const heatmapData: HeatmapsProps['data'] = [];
    let currentDate = startDate.clone();

    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, 'day')) {
      const formattedDate = currentDate.format('YYYY-MM-DD');
      const tokens = dateTokenMap.get(formattedDate) || 0;

      const level =
        tokens > 0 && maxTokens > 0
          ? Math.min(
              MAX_HEATMAP_LEVEL,
              Math.max(1, Math.ceil((tokens / maxTokens) * MAX_HEATMAP_LEVEL)),
            )
          : 0;

      heatmapData.push({
        count: tokens,
        date: formattedDate,
        level,
      });

      currentDate = currentDate.add(1, 'day');
    }

    return heatmapData;
  };

  getMaxTaskDuration = async (): Promise<number> => {
    const startDate = today().subtract(1, 'year').startOf('day').toDate();

    const [row] = await this.db
      .select({
        seconds:
          sql<number>`COALESCE(MAX(EXTRACT(EPOCH FROM (${agentOperations.completedAt} - ${agentOperations.startedAt}))), 0)`.mapWith(
            Number,
          ),
      })
      .from(agentOperations)
      .where(
        and(
          isNotNull(agentOperations.startedAt),
          isNotNull(agentOperations.completedAt),
          gte(agentOperations.createdAt, startDate),
        ),
      );

    return row?.seconds ?? 0;
  };

  /**
   * Explicit page size for detail usage rows. Chart aggregation never materializes
   * this set — use {@link findAndGroupByDay}. Prefer paging via
   * {@link findByDateRangePage} / {@link findByMonthPage}; uncapped drain is
   * hard-capped at {@link MAX_USAGE_DETAIL_ROWS} to avoid OOM.
   */
  static readonly USAGE_PAGE_DEFAULT = 100;
  static readonly USAGE_PAGE_MAX = 500;

  /**
   * Keyset-paginated usage detail for a date range (inclusive calendar days).
   * Does not return a truncated full-month array — use `nextCursor` to continue.
   */
  findByDateRangePage = async (
    startAt: string,
    endAt: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ items: GlobalUsageRecordItem[]; nextCursor: string | null }> => {
    const limit = Math.min(
      Math.max(Math.floor(options?.limit ?? PlatformGlobalStatsModel.USAGE_PAGE_DEFAULT), 1),
      PlatformGlobalStatsModel.USAGE_PAGE_MAX,
    );

    const conditions = genWhere([
      eq(messages.role, 'assistant'),
      genRangeWhere([startAt, endAt], messages.createdAt, (date) => date.toDate()),
    ]);

    const cursor = options?.cursor;
    let cursorCondition: ReturnType<typeof and> | undefined;
    if (cursor?.includes('|')) {
      const [iso, id] = cursor.split('|');
      const at = new Date(iso);
      if (!Number.isNaN(at.getTime()) && id) {
        cursorCondition = or(
          lt(messages.createdAt, at),
          and(eq(messages.createdAt, at), lt(messages.id, id)),
        )!;
      }
    }

    const spends = await this.db
      .select({
        createdAt: messages.createdAt,
        id: messages.id,
        metadata: messages.metadata,
        model: messages.model,
        provider: messages.provider,
        role: messages.role,
        usage: messages.usage,
        userDisplay: userDisplaySql,
        userId: messages.userId,
      })
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(cursorCondition ? and(conditions, cursorCondition) : conditions)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = spends.length > limit;
    const page = hasMore ? spends.slice(0, limit) : spends;
    const items = page.map((spend) => {
      const metadata = spend.metadata as MessageMetadata | null;
      // Prefer the dedicated `usage` column, then nested metadata.usage /
      // metadata.performance, then deprecated flat metadata fields (parity with
      // UsageRecordService.findByDateRange).
      const usage = spend.usage ?? metadata?.usage;
      const performance = metadata?.performance;
      const totalInputTokens = usage?.totalInputTokens ?? metadata?.totalInputTokens ?? 0;
      const totalOutputTokens = usage?.totalOutputTokens ?? metadata?.totalOutputTokens ?? 0;
      return {
        createdAt: spend.createdAt,
        id: spend.id,
        metadata: spend.metadata as MessageMetadata | null,
        model: spend.model ?? '',
        provider: spend.provider ?? '',
        spend: usage?.cost ?? metadata?.cost ?? 0,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        tps: performance?.tps ?? metadata?.tps ?? 0,
        ttft: performance?.ttft ?? metadata?.ttft ?? 0,
        type: 'chat',
        updatedAt: spend.createdAt,
        userDisplay: spend.userDisplay || spend.userId,
        userId: spend.userId,
      } satisfies GlobalUsageRecordItem;
    });

    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  };

  /**
   * Date-range usage detail. When `limit` is set, returns a single page (use
   * {@link findByDateRangePage} for cursors). When omitted, drains keyset pages
   * up to {@link MAX_USAGE_DETAIL_ROWS} (hard safety cap against OOM).
   */
  findByDateRange = async (
    startAt: string,
    endAt: string,
    options?: { limit?: number },
  ): Promise<GlobalUsageRecordItem[]> => {
    if (options?.limit !== undefined) {
      const { items } = await this.findByDateRangePage(startAt, endAt, options);
      return items;
    }

    const items: GlobalUsageRecordItem[] = [];
    let cursor: string | undefined;
    for (;;) {
      const remaining = MAX_USAGE_DETAIL_ROWS - items.length;
      if (remaining <= 0) break;

      const page = await this.findByDateRangePage(startAt, endAt, {
        cursor,
        limit: Math.min(PlatformGlobalStatsModel.USAGE_PAGE_MAX, remaining),
      });
      items.push(...page.items);
      if (!page.nextCursor || items.length >= MAX_USAGE_DETAIL_ROWS) break;
      cursor = page.nextCursor;
    }
    return items.length > MAX_USAGE_DETAIL_ROWS ? items.slice(0, MAX_USAGE_DETAIL_ROWS) : items;
  };

  /**
   * Explicitly paginated monthly usage detail (bounded page size; never silent full-month cap).
   */
  findByMonthPage = async (
    mo?: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ items: GlobalUsageRecordItem[]; nextCursor: string | null }> => {
    const { endAt, startAt } = this.resolveMonthRange(mo);
    return this.findByDateRangePage(startAt, endAt, options);
  };

  /**
   * Monthly usage detail. When `limit` is set, returns a single page; otherwise
   * drains via {@link findByDateRange} (hard-capped at {@link MAX_USAGE_DETAIL_ROWS}).
   */
  findByMonth = async (
    mo?: string,
    options?: { limit?: number },
  ): Promise<GlobalUsageRecordItem[]> => {
    if (options?.limit !== undefined) {
      const { items } = await this.findByMonthPage(mo, options);
      return items;
    }

    const { endAt, startAt } = this.resolveMonthRange(mo);
    return this.findByDateRange(startAt, endAt);
  };

  /**
   * Daily chart aggregates computed in SQL. Never materializes unbounded raw
   * message rows. Populates `records` with **per-day dimension aggregates**
   * (model × provider × user) so upstream charts can derive categories /
   * spend / tokens / call-group counts without loading every message.
   */
  findAndGroupByDay = async (mo?: string): Promise<GlobalUsageLog[]> => {
    const { endAt, startAt } = this.resolveMonthRange(mo);

    // Cost / token extraction mirrors findByDateRange fallback chain in SQL.
    const costExpr = sql<number>`COALESCE(
      (${messages.usage}->>'cost')::double precision,
      (${messages.metadata}->'usage'->>'cost')::double precision,
      (${messages.metadata}->>'cost')::double precision,
      0
    )`;
    const inputTokensExpr = sql<number>`COALESCE(
      (${messages.usage}->>'totalInputTokens')::double precision,
      (${messages.metadata}->'usage'->>'totalInputTokens')::double precision,
      (${messages.metadata}->>'totalInputTokens')::double precision,
      0
    )`;
    const outputTokensExpr = sql<number>`COALESCE(
      (${messages.usage}->>'totalOutputTokens')::double precision,
      (${messages.metadata}->'usage'->>'totalOutputTokens')::double precision,
      (${messages.metadata}->>'totalOutputTokens')::double precision,
      0
    )`;
    const dayExpr = sql<string>`to_char(date_trunc('day', ${messages.createdAt}), 'YYYY-MM-DD')`;
    const modelExpr = sql<string>`COALESCE(${messages.model}, '')`;
    const providerExpr = sql<string>`COALESCE(${messages.provider}, '')`;

    const rangeWhere = genWhere([
      eq(messages.role, 'assistant'),
      genRangeWhere([startAt, endAt], messages.createdAt, (date) => date.toDate()),
    ]);

    const [dayTotals, dimRows] = await Promise.all([
      this.db
        .select({
          day: dayExpr.as('day'),
          totalRequests: count(messages.id).mapWith(Number),
          totalSpend: sql<number>`COALESCE(SUM(${costExpr}), 0)`.mapWith(Number),
          totalTokens:
            sql<number>`COALESCE(SUM(${inputTokensExpr} + ${outputTokensExpr}), 0)`.mapWith(Number),
        })
        .from(messages)
        .where(rangeWhere)
        .groupBy(dayExpr)
        .orderBy(asc(dayExpr)),
      // Dimension rollup for chart categories (bounded by distinct combos/day, not raw rows).
      this.db
        .select({
          day: dayExpr.as('day'),
          model: modelExpr.as('model'),
          provider: providerExpr.as('provider'),
          spend: sql<number>`COALESCE(SUM(${costExpr}), 0)`.mapWith(Number),
          totalInputTokens: sql<number>`COALESCE(SUM(${inputTokensExpr}), 0)`.mapWith(Number),
          totalOutputTokens: sql<number>`COALESCE(SUM(${outputTokensExpr}), 0)`.mapWith(Number),
          userDisplay: userDisplaySql.as('user_display'),
          userId: messages.userId,
        })
        .from(messages)
        .leftJoin(users, eq(messages.userId, users.id))
        .where(rangeWhere)
        .groupBy(dayExpr, modelExpr, providerExpr, messages.userId, userDisplaySql)
        .orderBy(asc(dayExpr)),
    ]);

    const recordsByDay = new Map<string, GlobalUsageRecordItem[]>();
    for (const row of dimRows) {
      const dayAt = dayjs(row.day).startOf('day').toDate();
      const totalInputTokens = row.totalInputTokens;
      const totalOutputTokens = row.totalOutputTokens;
      // One row per (day, model, provider, user) — bounded by distinct combos, not raw msgs.
      // UI charts sum spend/tokens and collect model/provider/userId categories from these.
      // Call counts should use log.totalRequests (not records.length); see OUT_OF_SCOPE if UI still uses length.
      const record: GlobalUsageRecordItem = {
        createdAt: dayAt,
        id: `agg:${row.day}:${row.model}:${row.provider}:${row.userId}`,
        model: row.model,
        provider: row.provider,
        spend: row.spend,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        tps: 0,
        ttft: 0,
        type: 'chat',
        updatedAt: dayAt,
        userDisplay: row.userDisplay || row.userId,
        userId: row.userId,
      };
      const list = recordsByDay.get(row.day) ?? [];
      list.push(record);
      recordsByDay.set(row.day, list);
    }

    const byDay = new Map(
      dayTotals.map((row) => [
        row.day,
        {
          date: dayjs(row.day).toDate().getTime(),
          day: row.day,
          records: recordsByDay.get(row.day) ?? [],
          totalRequests: row.totalRequests,
          totalSpend: row.totalSpend,
          totalTokens: row.totalTokens,
        } satisfies GlobalUsageLog,
      ]),
    );

    // Inclusive end day (was exclusive isBefore → dropped last calendar day).
    const startDate = dayjs(startAt).startOf('day');
    const endDate = dayjs(endAt).startOf('day');
    const padded: GlobalUsageLog[] = [];
    for (let date = startDate; !date.isAfter(endDate, 'day'); date = date.add(1, 'day')) {
      const key = date.format('YYYY-MM-DD');
      const found = byDay.get(key);
      if (found) {
        padded.push(found);
      } else {
        padded.push({
          date: date.toDate().getTime(),
          day: key,
          records: [],
          totalRequests: 0,
          totalSpend: 0,
          totalTokens: 0,
        });
      }
    }
    return padded;
  };

  private resolveMonthRange = (mo?: string): { endAt: string; startAt: string } => {
    if (mo && dayjs(mo, 'YYYY-MM', true).isValid()) {
      return {
        endAt: dayjs(mo, 'YYYY-MM').endOf('month').format('YYYY-MM-DD'),
        startAt: dayjs(mo, 'YYYY-MM').startOf('month').format('YYYY-MM-DD'),
      };
    }
    return {
      endAt: dayjs().endOf('month').format('YYYY-MM-DD'),
      startAt: dayjs().startOf('month').format('YYYY-MM-DD'),
    };
  };
}

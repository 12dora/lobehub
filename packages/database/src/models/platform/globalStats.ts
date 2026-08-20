/**
 * Platform-wide (global) analytics aggregation — no ownership / workspace scope.
 *
 * Mirrors the business filters of MessageModel / TopicModel / AgentModel /
 * AgentOperationModel / UsageRecordService stats methods, without
 * `buildWorkspaceWhere`. Used only by admin.stats (platform_stats:read:all).
 */
import type { AgentRankItem, ModelRankItem, TopicRankItem } from '@lobechat/types';
import type { HeatmapsProps } from '@lobehub/charts';
import dayjs from 'dayjs';
import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { today } from '@/utils/time';

import { agents, messages, topics, users } from '../../schemas';
import { agentOperations } from '../../schemas/agentOperations';
import type { LobeChatDatabase } from '../../type';
import { genRangeWhere, genWhere } from '../../utils/genWhere';
import { normalizeInboxAgentMeta } from '../../utils/inboxAgent';
import { queryUsageLogsByDay } from './globalStatsGroupByDay';
import { fillCalendarHeatmap } from './globalStatsHeatmaps';
import type {
  ActivityPoint,
  ActivitySeriesParams,
  StatsFilterArg,
  StatsFilterParams,
} from './globalStatsRange';
import {
  deriveGranularity,
  eachBucketKey,
  eachUtcDayKey,
  genInstantRangeWhere,
  resolveActivityTimeZone,
  resolveStatsRange,
  toStatsFilterParams,
} from './globalStatsRange';
import type {
  CountDateParams,
  GlobalStatsTotals,
  GlobalUsageLog,
  GlobalUsageRecordItem,
  UserRankItem,
  UserRankOrderBy,
} from './globalStatsShared';
import {
  activityLevel,
  explicitRangeWhere,
  HEATMAP_MESSAGES_PER_LEVEL,
  isNonVirtualAgentSql,
  legacyDateWheres,
  MAX_HEATMAP_LEVEL,
  MAX_USAGE_DETAIL_ROWS,
  messageTotalTokensSql,
  selectUsageDetailProjection,
  toGlobalUsageRecordItem,
  usageCostSql,
  usageInputTokensSql,
  usageOutputTokensSql,
} from './globalStatsShared';

export type {
  ActivityGranularity,
  ActivityMetric,
  ActivityPoint,
  ActivitySeriesParams,
  ResolvedStatsRange,
  StatsFilterArg,
  StatsFilterParams,
  StatsRangeParams,
} from './globalStatsRange';
export {
  genInstantRangeWhere,
  MAX_STATS_RANGE_DAYS,
  resolveStatsRange,
  StatsRangeError,
  StatsTimeZoneError,
  toStatsFilterParams,
} from './globalStatsRange';
export type {
  CountDateParams,
  GlobalStatsTotals,
  GlobalUsageLog,
  GlobalUsageRecordItem,
  UserRankItem,
  UserRankOrderBy,
} from './globalStatsShared';
export {
  GROUP_BY_DAY_MAX_MODELS,
  GROUP_BY_DAY_MAX_PROVIDERS,
  GROUP_BY_DAY_OTHER_USER_ID,
  GROUP_BY_DAY_TOP_USERS,
  isNonVirtualAgentSql,
  MAX_USAGE_DETAIL_ROWS,
  messageTotalTokensSql,
} from './globalStatsShared';

export class PlatformGlobalStatsModel {
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  countUsers = async (params?: {
    activeDays?: number;
    endAt?: Date | string;
    startAt?: Date | string;
  }): Promise<{
    active: number;
    total: number;
  }> => {
    // Explicit window wins over `activeDays` (admin time-range filter).
    const windowWhere = explicitRangeWhere(params, users.lastActiveAt);
    const activeSince = dayjs()
      .subtract(params?.activeDays ?? 30, 'day')
      .toDate();

    const [totalRow] = await this.db.select({ count: count() }).from(users);
    const [activeRow] = await this.db
      .select({ count: count() })
      .from(users)
      .where(
        genWhere([
          isNotNull(users.lastActiveAt),
          windowWhere ?? gte(users.lastActiveAt, activeSince),
        ]),
      );

    return {
      active: activeRow?.count ?? 0,
      total: totalRow?.count ?? 0,
    };
  };

  countMessages = async (
    params?: CountDateParams & StatsFilterParams & { role?: string },
  ): Promise<number> => {
    const explicit = explicitRangeWhere(params, messages.createdAt);
    const result = await this.db
      .select({ count: count(messages.id) })
      .from(messages)
      .where(
        genWhere([
          params?.role ? eq(messages.role, params.role) : undefined,
          params?.userId ? eq(messages.userId, params.userId) : undefined,
          ...legacyDateWheres(explicit, params, messages.createdAt),
        ]),
      );

    return result[0]?.count ?? 0;
  };

  countTopics = async (params?: CountDateParams & StatsFilterParams): Promise<number> => {
    const explicit = explicitRangeWhere(params, topics.createdAt);
    const result = await this.db
      .select({ count: count(topics.id) })
      .from(topics)
      .where(
        genWhere([
          params?.userId ? eq(topics.userId, params.userId) : undefined,
          ...legacyDateWheres(explicit, params, topics.createdAt),
        ]),
      );

    return result[0]?.count ?? 0;
  };

  countAgents = async (params?: CountDateParams & StatsFilterParams): Promise<number> => {
    // Align with AgentModel.countAgents: non-virtual only (virtual=false OR virtual IS NULL).
    // Inbox (virtual=true) is intentionally excluded from countAgents; rankAgents uses
    // isNonVirtualAgentSql which additionally includes the inbox slug.
    const explicit = explicitRangeWhere(params, agents.createdAt);
    const result = await this.db
      .select({ count: count() })
      .from(agents)
      .where(
        genWhere([
          or(eq(agents.virtual, false), isNull(agents.virtual)),
          params?.userId ? eq(agents.userId, params.userId) : undefined,
          ...legacyDateWheres(explicit, params, agents.createdAt),
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

  /**
   * User totals only — avoids the three lifetime table scans in {@link totals}
   * when the caller only needs usersActive / usersTotal (admin overview KPIs).
   */
  userTotals = async (params?: {
    activeDays?: number;
    endAt?: Date | string;
    startAt?: Date | string;
  }): Promise<Pick<GlobalStatsTotals, 'usersActive' | 'usersTotal'>> => {
    const usersCount = await this.countUsers(params);
    return {
      usersActive: usersCount.active,
      usersTotal: usersCount.total,
    };
  };

  /**
   * Bounded daily token series for the admin overview chart.
   * SQL `GROUP BY day` only — never materializes per-message or per-user rows.
   */
  findDailyTokenTotals = async (
    arg?: StatsFilterArg,
  ): Promise<Array<{ day: string; totalTokens: number }>> => {
    const params = toStatsFilterParams(arg);
    const range = resolveStatsRange(params);
    const inputTokensExpr = usageInputTokensSql();
    const outputTokensExpr = usageOutputTokensSql();
    const dayExpr = sql<string>`to_char(date_trunc('day', ${messages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

    const rangeWhere = genWhere([
      eq(messages.role, 'assistant'),
      genInstantRangeWhere(range, messages.createdAt),
      params.userId ? eq(messages.userId, params.userId) : undefined,
    ]);

    const dayTotals = await this.db
      .select({
        day: dayExpr.as('day'),
        totalTokens:
          sql<number>`COALESCE(SUM(${inputTokensExpr} + ${outputTokensExpr}), 0)`.mapWith(Number),
      })
      .from(messages)
      .where(rangeWhere)
      .groupBy(dayExpr)
      .orderBy(asc(dayExpr));

    const byDay = new Map(dayTotals.map((row) => [row.day, row.totalTokens]));
    return eachUtcDayKey(range).map((day) => ({ day, totalTokens: byDay.get(day) ?? 0 }));
  };

  /**
   * Range-aware activity series behind the admin 活跃度 card.
   *
   * One `GROUP BY date_trunc(<granularity>, created_at AT TIME ZONE <tz>)` pass, zero-filled
   * across the whole half-open window so the chart never shows a hole. Without an explicit
   * bound the last 30 days ending now are used — never a full-table scan. `metric: 'messages'`
   * counts every message (no role gate, same population as {@link getHeatmaps});
   * `metric: 'tokens'` sums the assistant-gated {@link messageTotalTokensSql}, the same
   * expression {@link getTokenHeatmaps} uses. `level` keeps the two heatmap formulas: absolute
   * for messages, relative to the busiest bucket of the returned set for tokens.
   *
   * A derived granularity is only ever `hour` (span < 48h) or `day`, because an explicit window
   * may not span more than {@link MAX_STATS_RANGE_DAYS} days; `week` requires asking for it.
   */
  findActivitySeries = async (params?: ActivitySeriesParams): Promise<ActivityPoint[]> => {
    const timeZone = resolveActivityTimeZone(params?.timeZone);
    const metric = params?.metric ?? 'tokens';
    // Always bounded: a missing endAt resolves to now and a missing startAt to endAt − 30d.
    const range = resolveStatsRange({
      endAt: params?.endAt ?? new Date(),
      startAt: params?.startAt,
    });
    const granularity = params?.granularity ?? deriveGranularity(range);
    const buckets = eachBucketKey(range, granularity, timeZone);

    // Zone and unit travel as bind parameters — never string-concatenated into SQL.
    const bucketExpr = sql<string>`to_char(
      date_trunc(${granularity}, ${messages.createdAt} AT TIME ZONE ${timeZone}),
      ${granularity === 'hour' ? 'YYYY-MM-DD"T"HH24":00"' : 'YYYY-MM-DD'}
    )`;
    const countExpr =
      metric === 'messages'
        ? sql<number>`COUNT(${messages.id})`
        : sql<number>`COALESCE(SUM(${messageTotalTokensSql()}), 0)`;

    const rows = await this.db
      .select({ bucket: bucketExpr.as('bucket'), count: countExpr.mapWith(Number) })
      .from(messages)
      .where(
        genWhere([
          // Usage only ever lives on assistant replies; message counts cover every role.
          metric === 'tokens' ? eq(messages.role, 'assistant') : undefined,
          genInstantRangeWhere(range, messages.createdAt),
          params?.userId ? eq(messages.userId, params.userId) : undefined,
        ]),
      )
      // Group by the projected column: repeating the expression would re-bind the zone /
      // unit parameters, and PostgreSQL never matches two distinct placeholders.
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const byBucket = new Map(rows.map((row) => [row.bucket, row.count]));
    const maxCount = rows.reduce((max, row) => Math.max(max, row.count), 0);

    return buckets.map((bucket) => {
      const value = byBucket.get(bucket) ?? 0;
      return { bucket, count: value, level: activityLevel(metric, value, maxCount) };
    });
  };

  /** Ranks the messages themselves — window and user filter apply to `messages`. */
  rankModels = async (
    limit: number = 10,
    options?: StatsFilterParams,
  ): Promise<ModelRankItem[]> => {
    return this.db
      .select({
        count: count(messages.id).as('count'),
        id: messages.model,
      })
      .from(messages)
      .where(
        genWhere([
          isNotNull(messages.model),
          explicitRangeWhere(options, messages.createdAt),
          options?.userId ? eq(messages.userId, options.userId) : undefined,
        ]),
      )
      .having(({ count: c }) => gt(c, 0))
      .groupBy(messages.model)
      .orderBy(desc(sql`count`), asc(messages.model))
      .limit(limit) as Promise<ModelRankItem[]>;
  };

  /**
   * Ranks assistants by the topics opened on them. The window / user filter applies to
   * the counted rows (topics), so an assistant only ranks for what happened in-window.
   */
  rankAgents = async (
    limit: number = 10,
    options?: StatsFilterParams,
  ): Promise<AgentRankItem[]> => {
    const joinWhere = genWhere([
      eq(topics.agentId, agents.id),
      explicitRangeWhere(options, topics.createdAt),
      options?.userId ? eq(topics.userId, options.userId) : undefined,
    ]);

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
      .leftJoin(topics, joinWhere)
      // Same legacy population as countAgents (virtual=false OR NULL) + inbox (DB-009).
      .where(isNonVirtualAgentSql())
      .groupBy(agents.id)
      .having(({ count: c }) => gt(c, 0))
      .orderBy(desc(sql`count`))
      .limit(limit);

    return rows.map(({ slug, ...row }) => normalizeInboxAgentMeta(row, { slug }));
  };

  /** Ranks topics by in-window message volume; the user filter scopes topic ownership. */
  rankTopics = async (
    limit: number = 10,
    options?: StatsFilterParams,
  ): Promise<Array<TopicRankItem & { userId: string }>> => {
    const joinWhere = genWhere([
      eq(topics.id, messages.topicId),
      explicitRangeWhere(options, messages.createdAt),
    ]);

    return this.db
      .select({
        agentId: topics.agentId,
        count: count(messages.id).as('count'),
        id: topics.id,
        title: topics.title,
        userId: topics.userId,
      })
      .from(topics)
      .leftJoin(messages, joinWhere)
      .where(genWhere([options?.userId ? eq(topics.userId, options.userId) : undefined]))
      .groupBy(topics.id)
      .orderBy(desc(sql`count`))
      .having(({ count: c }) => gt(c, 0))
      .limit(limit);
  };

  /**
   * Users ranked by token usage in the window (admin 用户排行).
   *
   * `messages` counts every message the user wrote in the window (same population as
   * {@link countMessages}); tokens / cost are summed over assistant rows only — the same
   * role gate the other usage aggregates use, so stray usage payloads on a user row can
   * never inflate a ranking. Never emits the raw email as a separate field — the display
   * name is the same COALESCE chain used by the usage endpoints.
   *
   * Without an explicit window the last {@link DEFAULT_EXPLICIT_RANGE_DAYS} days ending
   * now are used: this endpoint never scans the whole `messages` table.
   *
   * `orderBy` sorts in SQL (DESC, tie-break `userId` ASC) so `limit` really is the top-N
   * for that metric — a client must not re-sort a token-ordered page.
   */
  rankUsers = async (params?: {
    endAt?: Date | string;
    limit?: number;
    orderBy?: UserRankOrderBy;
    startAt?: Date | string;
    userId?: string;
  }): Promise<UserRankItem[]> => {
    const limit = Math.min(Math.max(Math.floor(params?.limit ?? 10), 1), 100);
    // Always bounded: a missing endAt resolves to now and a missing startAt to endAt − 30d.
    const range = resolveStatsRange({
      endAt: params?.endAt ?? new Date(),
      startAt: params?.startAt,
    });
    const costExpr = usageCostSql();
    const inputTokensExpr = usageInputTokensSql();
    const outputTokensExpr = usageOutputTokensSql();
    // users row may be missing (deleted account) — fall back to the message's userId.
    const nameExpr = sql<string>`COALESCE(NULLIF(TRIM(${users.fullName}), ''), NULLIF(TRIM(${users.username}), ''), NULLIF(TRIM(${users.email}), ''), ${users.id}, ${messages.userId})`;
    /** Usage lives on assistant replies — gate every SUM, never the message COUNT. */
    const assistantOnly = sql`FILTER (WHERE ${messages.role} = 'assistant')`;
    const costSumExpr = sql<number>`COALESCE(SUM(${costExpr}) ${assistantOnly}, 0)`;
    const inputSumExpr = sql<number>`COALESCE(SUM(${inputTokensExpr}) ${assistantOnly}, 0)`;
    const outputSumExpr = sql<number>`COALESCE(SUM(${outputTokensExpr}) ${assistantOnly}, 0)`;
    const totalTokensExpr = sql<number>`COALESCE(SUM(${inputTokensExpr} + ${outputTokensExpr}) ${assistantOnly}, 0)`;
    const messagesCountExpr = count(messages.id);
    const orderByExpr = {
      cost: costSumExpr,
      messages: messagesCountExpr,
      totalTokens: totalTokensExpr,
    }[params?.orderBy ?? 'totalTokens'];

    const rows = await this.db
      .select({
        avatar: users.avatar,
        cost: costSumExpr.mapWith(Number),
        inputTokens: inputSumExpr.mapWith(Number),
        messages: messagesCountExpr.mapWith(Number),
        name: nameExpr,
        outputTokens: outputSumExpr.mapWith(Number),
        totalTokens: totalTokensExpr.mapWith(Number),
        userId: messages.userId,
      })
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(
        genWhere([
          genInstantRangeWhere(range, messages.createdAt),
          params?.userId ? eq(messages.userId, params.userId) : undefined,
        ]),
      )
      .groupBy(messages.userId, nameExpr, users.avatar)
      .orderBy(desc(orderByExpr), asc(messages.userId))
      .limit(limit);

    return rows.map((row) => ({
      avatar: row.avatar ?? null,
      cost: row.cost ?? 0,
      inputTokens: Math.round(row.inputTokens ?? 0),
      messages: row.messages ?? 0,
      name: row.name || row.userId,
      outputTokens: Math.round(row.outputTokens ?? 0),
      totalTokens: Math.round(row.totalTokens ?? 0),
      userId: row.userId,
    }));
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

    const dateCountMap = new Map<string, number>();
    for (const item of result) {
      if (item?.date) {
        const dateStr = dayjs(item.date as string).format('YYYY-MM-DD');
        dateCountMap.set(dateStr, item.count);
      }
    }

    return fillCalendarHeatmap({
      endDate,
      levelOf: (dayCount) => {
        const levelCount = dayCount > 0 ? Math.ceil(dayCount / HEATMAP_MESSAGES_PER_LEVEL) : 0;
        return Math.min(MAX_HEATMAP_LEVEL, levelCount);
      },
      startDate,
      values: dateCountMap,
    });
  };

  getTokenHeatmaps = async (): Promise<HeatmapsProps['data']> => {
    const startDate = today().subtract(1, 'year').startOf('day');
    const endDate = today().endOf('day');

    const result = await this.db
      .select({
        date: sql`DATE(${messages.createdAt})`.as('heatmaps_date'),
        tokens: sql<number>`COALESCE(SUM(${messageTotalTokensSql()}), 0)`.mapWith(Number),
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

    return fillCalendarHeatmap({
      endDate,
      levelOf: (tokens) =>
        tokens > 0 && maxTokens > 0
          ? Math.min(
              MAX_HEATMAP_LEVEL,
              Math.max(1, Math.ceil((tokens / maxTokens) * MAX_HEATMAP_LEVEL)),
            )
          : 0,
      startDate,
      values: dateTokenMap,
    });
  };

  /**
   * Longest completed agent task, in seconds. An explicit `[startAt, endAt)` window (and
   * optional `userId`) narrows it to the admin filter; without one the trailing year is
   * kept, so the personal / unfiltered call sites are unchanged.
   */
  getMaxTaskDuration = async (params?: StatsFilterParams): Promise<number> => {
    const explicit = explicitRangeWhere(params, agentOperations.createdAt);
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
        genWhere([
          isNotNull(agentOperations.startedAt),
          isNotNull(agentOperations.completedAt),
          params?.userId ? eq(agentOperations.userId, params.userId) : undefined,
          explicit ?? gte(agentOperations.createdAt, startDate),
        ]),
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
    startAt: Date | string,
    endAt: Date | string,
    options?: { cursor?: string; limit?: number; userId?: string },
  ): Promise<{ items: GlobalUsageRecordItem[]; nextCursor: string | null }> => {
    const limit = Math.min(
      Math.max(Math.floor(options?.limit ?? PlatformGlobalStatsModel.USAGE_PAGE_DEFAULT), 1),
      PlatformGlobalStatsModel.USAGE_PAGE_MAX,
    );

    const conditions = genWhere([
      eq(messages.role, 'assistant'),
      genInstantRangeWhere(resolveStatsRange({ endAt, startAt }), messages.createdAt),
      options?.userId ? eq(messages.userId, options.userId) : undefined,
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
      .select(selectUsageDetailProjection)
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(cursorCondition ? and(conditions, cursorCondition) : conditions)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = spends.length > limit;
    const page = hasMore ? spends.slice(0, limit) : spends;
    const items = page.map(toGlobalUsageRecordItem);

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
    startAt: Date | string,
    endAt: Date | string,
    options?: { limit?: number; userId?: string },
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
        userId: options?.userId,
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
    arg?: StatsFilterArg,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ items: GlobalUsageRecordItem[]; nextCursor: string | null }> => {
    const params = toStatsFilterParams(arg);
    const { endAt, startAt } = resolveStatsRange(params);
    return this.findByDateRangePage(startAt, endAt, { ...options, userId: params.userId });
  };

  /**
   * Single-query full-month usage detail with a hard row ceiling (routers/F4).
   * Fetches `maxRows + 1` rows; when more remain, returns `hasMore: true` so the
   * router can fail closed with `usage_month_truncated` without 200 serial pages.
   */
  findByMonthBounded = async (
    arg: StatsFilterArg,
    maxRows: number,
  ): Promise<{ hasMore: boolean; items: GlobalUsageRecordItem[] }> => {
    const limit = Math.max(1, Math.floor(maxRows));
    // One range query with LIMIT maxRows+1 — same projection as keyset pages.
    const params = toStatsFilterParams(arg);
    const conditions = genWhere([
      eq(messages.role, 'assistant'),
      genInstantRangeWhere(resolveStatsRange(params), messages.createdAt),
      params.userId ? eq(messages.userId, params.userId) : undefined,
    ]);

    const spends = await this.db
      .select(selectUsageDetailProjection)
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(conditions)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = spends.length > limit;
    const page = hasMore ? spends.slice(0, limit) : spends;
    const items = page.map(toGlobalUsageRecordItem);

    return { hasMore, items };
  };

  /**
   * Monthly usage detail. When `limit` is set, returns a single page; otherwise
   * drains via {@link findByDateRange} (hard-capped at {@link MAX_USAGE_DETAIL_ROWS}).
   */
  findByMonth = async (
    arg?: StatsFilterArg,
    options?: { limit?: number },
  ): Promise<GlobalUsageRecordItem[]> => {
    if (options?.limit !== undefined) {
      const { items } = await this.findByMonthPage(arg, options);
      return items;
    }

    const params = toStatsFilterParams(arg);
    const { endAt, startAt } = resolveStatsRange(params);
    return this.findByDateRange(startAt, endAt, { userId: params.userId });
  };

  /**
   * Daily chart aggregates computed in SQL. Never materializes unbounded raw
   * message rows. Populates `records` with **capped per-day dimension aggregates**:
   * top-N users by tokens + an aggregated `__other__` user bucket, with model and
   * provider cardinality caps (platform-instance/F6). GroupBy.User always gets
   * non-blank userId/displayName series.
   */
  findAndGroupByDay = async (arg?: StatsFilterArg): Promise<GlobalUsageLog[]> => {
    return queryUsageLogsByDay(this.db, arg);
  };
}

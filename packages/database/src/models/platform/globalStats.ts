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
import utc from 'dayjs/plugin/utc';
import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import type { MessageMetadata } from '@/types/message';
import type { UsageLog, UsageRecordItem } from '@/types/usage/usageRecord';
import { today } from '@/utils/time';

import { agents, messages, topics, users } from '../../schemas';
import { agentOperations } from '../../schemas/agentOperations';
import type { LobeChatDatabase } from '../../type';
import { genEndDateWhere, genRangeWhere, genStartDateWhere, genWhere } from '../../utils/genWhere';
import { normalizeInboxAgentMeta } from '../../utils/inboxAgent';

dayjs.extend(utc);

/**
 * Parse a calendar day (`YYYY-MM-DD`) as UTC midnight.
 * Explicit UTC policy so half-open bounds do not shift with the process timezone (DB-008).
 */
const utcDayStart = (ymd: string): Date | null => {
  // Accept only date-shaped input; reject timestamps so callers stay calendar-day based.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const d = new Date(ymd);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(`${ymd}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const utcDayAfter = (ymd: string): Date | null => {
  const start = utcDayStart(ymd);
  if (!start) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
};

/**
 * Half-open calendar-day range for platform usage detail/chart (DB-008).
 * Inclusive of `startDate` 00:00:00.000Z; exclusive of the day after `endDate` 00:00:00.000Z.
 * Avoids the upstream `genRangeWhere` end predicate (`<= endDate + 1 day`) that
 * includes exactly midnight of the following day.
 */
export const genHalfOpenDayRangeWhere = (
  range: [string, string] | undefined,
  key: typeof messages.createdAt,
): ReturnType<typeof and> | undefined => {
  if (!range) return;
  const startAt = range[0] ? utcDayStart(range[0]) : null;
  const endExclusive = range[1] ? utcDayAfter(range[1]) : null;
  if (!startAt && !endExclusive) return;
  if (!startAt && endExclusive) return lt(key, endExclusive);
  if (startAt && !endExclusive) return gte(key, startAt);
  return and(gte(key, startAt!), lt(key, endExclusive!));
};

/**
 * Non-virtual agents including legacy `virtual IS NULL` rows (DB-009).
 * Shared by {@link PlatformGlobalStatsModel.countAgents} and rankAgents so totals
 * and rankings operate on the same population. Inbox slug is always included.
 */
export const isNonVirtualAgentSql = () =>
  or(eq(agents.slug, INBOX_SESSION_ID), eq(agents.virtual, false), isNull(agents.virtual));

/**
 * Hard safety cap for uncapped {@link PlatformGlobalStatsModel.findByDateRange} /
 * {@link PlatformGlobalStatsModel.findByMonth} drains. Prevents unbounded in-memory
 * materialization of raw message rows (admin OOM risk). Prefer keyset paging via
 * findByDateRangePage / findByMonthPage for large ranges; charts use findAndGroupByDay.
 */
export const MAX_USAGE_DETAIL_ROWS = 20000;

/**
 * Chart path cardinality caps for {@link PlatformGlobalStatsModel.findAndGroupByDay}.
 * Per-user series stays populated for GroupBy.User; long-tail users fold into `other`.
 */
export const GROUP_BY_DAY_TOP_USERS = 20;
/** Max distinct model values kept per day (remainder rolled into `__other__` model). */
export const GROUP_BY_DAY_MAX_MODELS = 30;
/** Max distinct provider values kept per day (remainder rolled into `__other__` provider). */
export const GROUP_BY_DAY_MAX_PROVIDERS = 20;
/** Synthetic userId for aggregated long-tail users (never blank). */
export const GROUP_BY_DAY_OTHER_USER_ID = '__other__';

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

type GroupByDayDimRow = {
  day: string;
  model: string;
  provider: string;
  spend: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  userDisplay: string | null;
  userId: string;
};

const asRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
};

/**
 * Cap day-level chart series: top-N users by tokens + `__other__`, and
 * model/provider cardinality. Never emits blank userId (GroupBy.User).
 */
const capGroupByDayRecords = (day: string, rows: GroupByDayDimRow[]): GlobalUsageRecordItem[] => {
  if (rows.length === 0) return [];

  // User totals for ranking.
  const userTotals = new Map<string, { display: string; tokens: number }>();
  for (const row of rows) {
    const uid = row.userId || GROUP_BY_DAY_OTHER_USER_ID;
    const prev = userTotals.get(uid);
    const tokens = row.totalInputTokens + row.totalOutputTokens;
    const display = (row.userDisplay || row.userId || GROUP_BY_DAY_OTHER_USER_ID).trim();
    if (prev) {
      prev.tokens += tokens;
    } else {
      userTotals.set(uid, { display, tokens });
    }
  }

  const rankedUsers = [...userTotals.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]),
  );
  const topUserIds = new Set(rankedUsers.slice(0, GROUP_BY_DAY_TOP_USERS).map(([id]) => id));

  // Model / provider global cardinality for the day (by token mass).
  const modelTokens = new Map<string, number>();
  const providerTokens = new Map<string, number>();
  for (const row of rows) {
    const tokens = row.totalInputTokens + row.totalOutputTokens;
    const model = row.model || '__other__';
    const provider = row.provider || '__other__';
    modelTokens.set(model, (modelTokens.get(model) ?? 0) + tokens);
    providerTokens.set(provider, (providerTokens.get(provider) ?? 0) + tokens);
  }
  const topModels = new Set(
    [...modelTokens.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, GROUP_BY_DAY_MAX_MODELS)
      .map(([id]) => id),
  );
  const topProviders = new Set(
    [...providerTokens.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, GROUP_BY_DAY_MAX_PROVIDERS)
      .map(([id]) => id),
  );

  // Merge into (userId, model, provider) buckets after caps.
  type Bucket = {
    model: string;
    provider: string;
    spend: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    userDisplay: string;
    userId: string;
  };
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    let userId = row.userId || GROUP_BY_DAY_OTHER_USER_ID;
    let userDisplay = (row.userDisplay || row.userId || 'Other').trim() || userId;
    if (!topUserIds.has(userId)) {
      userId = GROUP_BY_DAY_OTHER_USER_ID;
      userDisplay = 'Other';
    }

    let model = row.model || '';
    if (model && !topModels.has(model)) model = '__other__';
    let provider = row.provider || '';
    if (provider && !topProviders.has(provider)) provider = '__other__';

    const key = `${userId}\0${model}\0${provider}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.spend += row.spend;
      existing.totalInputTokens += row.totalInputTokens;
      existing.totalOutputTokens += row.totalOutputTokens;
    } else {
      buckets.set(key, {
        model,
        provider,
        spend: row.spend,
        totalInputTokens: row.totalInputTokens,
        totalOutputTokens: row.totalOutputTokens,
        userDisplay,
        userId,
      });
    }
  }

  const dayAt = dayjs.utc(day).startOf('day').toDate();
  return [...buckets.values()].map((b) => {
    const totalInputTokens = b.totalInputTokens;
    const totalOutputTokens = b.totalOutputTokens;
    return {
      createdAt: dayAt,
      id: `agg:${day}:${b.userId}:${b.model}:${b.provider}`,
      model: b.model,
      provider: b.provider,
      spend: b.spend,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      tps: 0,
      ttft: 0,
      type: 'chat' as const,
      updatedAt: dayAt,
      userDisplay: b.userDisplay,
      userId: b.userId,
    } satisfies GlobalUsageRecordItem;
  });
};

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
    // Align with AgentModel.countAgents: non-virtual only (virtual=false OR virtual IS NULL).
    // Inbox (virtual=true) is intentionally excluded from countAgents; rankAgents uses
    // isNonVirtualAgentSql which additionally includes the inbox slug.
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

  /**
   * User totals only — avoids the three lifetime table scans in {@link totals}
   * when the caller only needs usersActive / usersTotal (admin overview KPIs).
   */
  userTotals = async (params?: {
    activeDays?: number;
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
    mo?: string,
  ): Promise<Array<{ day: string; totalTokens: number }>> => {
    const { endAt, startAt } = this.resolveMonthRange(mo);
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
    const dayExpr = sql<string>`to_char(date_trunc('day', ${messages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

    const rangeWhere = genWhere([
      eq(messages.role, 'assistant'),
      genHalfOpenDayRangeWhere([startAt, endAt], messages.createdAt),
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
    const startDate = dayjs.utc(startAt).startOf('day');
    const endDate = dayjs.utc(endAt).startOf('day');
    const padded: Array<{ day: string; totalTokens: number }> = [];
    for (let date = startDate; !date.isAfter(endDate, 'day'); date = date.add(1, 'day')) {
      const key = date.format('YYYY-MM-DD');
      padded.push({ day: key, totalTokens: byDay.get(key) ?? 0 });
    }
    return padded;
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
      // Same legacy population as countAgents (virtual=false OR NULL) + inbox (DB-009).
      .where(isNonVirtualAgentSql())
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
      genHalfOpenDayRangeWhere([startAt, endAt], messages.createdAt),
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
   * Single-query full-month usage detail with a hard row ceiling (routers/F4).
   * Fetches `maxRows + 1` rows; when more remain, returns `hasMore: true` so the
   * router can fail closed with `usage_month_truncated` without 200 serial pages.
   */
  findByMonthBounded = async (
    mo: string | undefined,
    maxRows: number,
  ): Promise<{ hasMore: boolean; items: GlobalUsageRecordItem[] }> => {
    const limit = Math.max(1, Math.floor(maxRows));
    // One range query with LIMIT maxRows+1 — same projection as keyset pages.
    const { endAt, startAt } = this.resolveMonthRange(mo);
    const conditions = genWhere([
      eq(messages.role, 'assistant'),
      genHalfOpenDayRangeWhere([startAt, endAt], messages.createdAt),
    ]);

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
      .where(conditions)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = spends.length > limit;
    const page = hasMore ? spends.slice(0, limit) : spends;
    const items = page.map((spend) => {
      const metadata = spend.metadata as MessageMetadata | null;
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

    return { hasMore, items };
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
   * message rows. Populates `records` with **capped per-day dimension aggregates**:
   * top-N users by tokens + an aggregated `__other__` user bucket, with model and
   * provider cardinality caps (platform-instance/F6). GroupBy.User always gets
   * non-blank userId/displayName series.
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
    const dayExpr = sql<string>`to_char(date_trunc('day', ${messages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
    const modelExpr = sql<string>`COALESCE(${messages.model}, '')`;
    const providerExpr = sql<string>`COALESCE(${messages.provider}, '')`;

    const rangeWhere = genWhere([
      eq(messages.role, 'assistant'),
      genHalfOpenDayRangeWhere([startAt, endAt], messages.createdAt),
    ]);

    const [dayTotals, dimResult] = await Promise.all([
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
      // Rank and fold every dimension before rows cross the DB boundary. The
      // second aggregation gives the result a hard day × capped-dimension bound.
      this.db.execute(sql`
        WITH base AS (
          SELECT
            ${dayExpr} AS day,
            COALESCE(${messages.userId}, ${GROUP_BY_DAY_OTHER_USER_ID}) AS user_id,
            ${userDisplaySql} AS user_display,
            ${modelExpr} AS model,
            ${providerExpr} AS provider,
            COALESCE(SUM(${costExpr}), 0)::double precision AS spend,
            COALESCE(SUM(${inputTokensExpr}), 0)::double precision AS input_tokens,
            COALESCE(SUM(${outputTokensExpr}), 0)::double precision AS output_tokens
          FROM ${messages}
          LEFT JOIN ${users} ON ${messages.userId} = ${users.id}
          WHERE ${rangeWhere}
          GROUP BY ${dayExpr}, ${messages.userId}, ${userDisplaySql}, ${modelExpr}, ${providerExpr}
        ),
        user_ranked AS (
          SELECT
            day,
            user_id,
            ROW_NUMBER() OVER (
              PARTITION BY day
              ORDER BY SUM(input_tokens + output_tokens) DESC, user_id ASC
            ) AS rank
          FROM base
          GROUP BY day, user_id
        ),
        model_ranked AS (
          SELECT
            day,
            model,
            ROW_NUMBER() OVER (
              PARTITION BY day
              ORDER BY SUM(input_tokens + output_tokens) DESC, model ASC
            ) AS rank
          FROM base
          GROUP BY day, model
        ),
        provider_ranked AS (
          SELECT
            day,
            provider,
            ROW_NUMBER() OVER (
              PARTITION BY day
              ORDER BY SUM(input_tokens + output_tokens) DESC, provider ASC
            ) AS rank
          FROM base
          GROUP BY day, provider
        ),
        labeled AS (
          SELECT
            base.day,
            CASE
              WHEN user_ranked.rank <= ${GROUP_BY_DAY_TOP_USERS} THEN base.user_id
              ELSE ${GROUP_BY_DAY_OTHER_USER_ID}
            END AS user_id,
            CASE
              WHEN user_ranked.rank <= ${GROUP_BY_DAY_TOP_USERS}
                THEN COALESCE(NULLIF(TRIM(base.user_display), ''), base.user_id)
              ELSE 'Other'
            END AS user_display,
            CASE
              WHEN base.model = '' OR model_ranked.rank <= ${GROUP_BY_DAY_MAX_MODELS}
                THEN base.model
              ELSE '__other__'
            END AS model,
            CASE
              WHEN base.provider = '' OR provider_ranked.rank <= ${GROUP_BY_DAY_MAX_PROVIDERS}
                THEN base.provider
              ELSE '__other__'
            END AS provider,
            base.spend,
            base.input_tokens,
            base.output_tokens
          FROM base
          INNER JOIN user_ranked
            ON base.day = user_ranked.day AND base.user_id = user_ranked.user_id
          INNER JOIN model_ranked
            ON base.day = model_ranked.day AND base.model = model_ranked.model
          INNER JOIN provider_ranked
            ON base.day = provider_ranked.day AND base.provider = provider_ranked.provider
        )
        SELECT
          day,
          model,
          provider,
          SUM(spend)::double precision AS spend,
          SUM(input_tokens)::double precision AS "totalInputTokens",
          SUM(output_tokens)::double precision AS "totalOutputTokens",
          MAX(user_display) AS "userDisplay",
          user_id AS "userId"
        FROM labeled
        GROUP BY day, user_id, model, provider
        ORDER BY day, user_id, model, provider
      `),
    ]);
    const dimRows = asRows<GroupByDayDimRow>(dimResult);

    type DimRow = (typeof dimRows)[number];
    const rowsByDay = new Map<string, DimRow[]>();
    for (const row of dimRows) {
      const list = rowsByDay.get(row.day) ?? [];
      list.push(row);
      rowsByDay.set(row.day, list);
    }

    const recordsByDay = new Map<string, GlobalUsageRecordItem[]>();
    for (const [day, rows] of rowsByDay) {
      recordsByDay.set(day, capGroupByDayRecords(day, rows));
    }

    const byDay = new Map(
      dayTotals.map((row) => [
        row.day,
        {
          date: dayjs.utc(row.day).toDate().getTime(),
          day: row.day,
          records: recordsByDay.get(row.day) ?? [],
          totalRequests: row.totalRequests,
          totalSpend: row.totalSpend,
          totalTokens: row.totalTokens,
        } satisfies GlobalUsageLog,
      ]),
    );

    // Inclusive end day (was exclusive isBefore → dropped last calendar day).
    const startDate = dayjs.utc(startAt).startOf('day');
    const endDate = dayjs.utc(endAt).startOf('day');
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
    if (mo && dayjs.utc(mo, 'YYYY-MM', true).isValid()) {
      return {
        endAt: dayjs.utc(mo, 'YYYY-MM').endOf('month').format('YYYY-MM-DD'),
        startAt: dayjs.utc(mo, 'YYYY-MM').startOf('month').format('YYYY-MM-DD'),
      };
    }
    return {
      endAt: dayjs.utc().endOf('month').format('YYYY-MM-DD'),
      startAt: dayjs.utc().startOf('month').format('YYYY-MM-DD'),
    };
  };
}

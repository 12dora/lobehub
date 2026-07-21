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
import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import { today } from '@/utils/time';

import { agents, messages, topics, users } from '../../schemas';
import { agentOperations } from '../../schemas/agentOperations';
import type { LobeChatDatabase } from '../../type';
import { genEndDateWhere, genRangeWhere, genStartDateWhere, genWhere } from '../../utils/genWhere';
import { normalizeInboxAgentMeta } from '../../utils/inboxAgent';

export type GlobalUsageRecordItem = {
  createdAt: Date;
  id: string;
  metadata?: unknown;
  model: string | null;
  provider: string | null;
  spend: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  tps: number;
  ttft: number;
  type: string;
  updatedAt: Date;
  userDisplay: string;
  userId: string;
};

export type GlobalUsageLog = {
  date: number;
  day: string;
  records: GlobalUsageRecordItem[];
  totalRequests: number;
  totalSpend: number;
  totalTokens: number;
};

export type GlobalStatsTotals = {
  agents: number;
  messages: number;
  topics: number;
  /** Users active within the last `activeDays` (by lastActiveAt). */
  usersActive: number;
  usersTotal: number;
};

const formatDay = (date?: Date) => {
  if (!date) return '--';
  return dayjs(date).format('YYYY-MM-DD');
};

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

      const levelCount = dayCount > 0 ? Math.ceil(dayCount / 5) : 0;
      const level = levelCount > 4 ? 4 : levelCount;

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
          ? Math.min(4, Math.max(1, Math.ceil((tokens / maxTokens) * 4)))
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

  findByDateRange = async (startAt: string, endAt: string): Promise<GlobalUsageRecordItem[]> => {
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
      .where(
        genWhere([
          eq(messages.role, 'assistant'),
          genRangeWhere([startAt, endAt], messages.createdAt, (date) => date.toDate()),
        ]),
      )
      .orderBy(desc(messages.createdAt));

    return spends.map((spend) => {
      const metadata = spend.metadata as {
        cost?: number;
        performance?: { tps?: number; ttft?: number };
        totalInputTokens?: number;
        totalOutputTokens?: number;
        usage?: {
          cost?: number;
          totalInputTokens?: number;
          totalOutputTokens?: number;
        };
      } | null;
      const usage =
        (spend.usage as {
          cost?: number;
          totalInputTokens?: number;
          totalOutputTokens?: number;
        } | null) ?? metadata?.usage;
      const performance = metadata?.performance;
      const totalInputTokens = usage?.totalInputTokens ?? metadata?.totalInputTokens ?? 0;
      const totalOutputTokens = usage?.totalOutputTokens ?? metadata?.totalOutputTokens ?? 0;
      return {
        createdAt: spend.createdAt,
        id: spend.id,
        metadata: spend.metadata,
        model: spend.model,
        provider: spend.provider,
        spend: usage?.cost ?? metadata?.cost ?? 0,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        tps: performance?.tps ?? 0,
        ttft: performance?.ttft ?? 0,
        type: 'chat',
        updatedAt: spend.createdAt,
        userDisplay: spend.userDisplay || spend.userId,
        userId: spend.userId,
      };
    });
  };

  findByMonth = async (mo?: string): Promise<GlobalUsageRecordItem[]> => {
    const { endAt, startAt } = this.resolveMonthRange(mo);
    return this.findByDateRange(startAt, endAt);
  };

  findAndGroupByDay = async (mo?: string): Promise<GlobalUsageLog[]> => {
    const { endAt, startAt } = this.resolveMonthRange(mo);
    const spends = await this.findByDateRange(startAt, endAt);
    return this.groupByDay(spends, startAt, endAt);
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

  private groupByDay = (
    spends: GlobalUsageRecordItem[],
    startAt: string,
    endAt: string,
  ): GlobalUsageLog[] => {
    const usages = new Map<string, { date: Date; logs: GlobalUsageRecordItem[] }>();
    for (const spend of spends) {
      const day = formatDay(spend.createdAt);
      if (!usages.has(day)) {
        usages.set(day, { date: spend.createdAt, logs: [spend] });
        continue;
      }
      usages.get(day)?.logs.push(spend);
    }

    const usageLogs: GlobalUsageLog[] = [];
    usages.forEach((bucket, day) => {
      usageLogs.push({
        date: bucket.date.getTime(),
        day,
        records: bucket.logs,
        totalRequests: bucket.logs.length,
        totalSpend: bucket.logs.reduce((acc, s) => acc + s.spend, 0),
        totalTokens: bucket.logs.reduce((acc, s) => (s.totalTokens || 0) + acc, 0),
      });
    });

    const startDate = dayjs(startAt);
    const endDate = dayjs(endAt);
    const padded: GlobalUsageLog[] = [];
    for (let date = startDate; date.isBefore(endDate); date = date.add(1, 'day')) {
      const found = usageLogs.find((l) => l.day === date.format('YYYY-MM-DD'));
      if (found) {
        padded.push(found);
      } else {
        padded.push({
          date: date.toDate().getTime(),
          day: date.format('YYYY-MM-DD'),
          records: [],
          totalRequests: 0,
          totalSpend: 0,
          totalTokens: 0,
        });
      }
    }
    return padded;
  };
}

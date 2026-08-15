'use client';

import type { AgentRankItem, ModelRankItem, TopicRankItem } from '@lobechat/types';
import type { HeatmapsProps } from '@lobehub/charts';
import { createContext, type ReactNode, use } from 'react';

import { agentService } from '@/services/agent';
import { messageService } from '@/services/message';
import { topicService } from '@/services/topic';
import { usageService } from '@/services/usage';
import type { UsageLog, UsageRecordItem } from '@/types/usage/usageRecord';

/** Default / personal settings-stats SWR scope. Keys stay unchanged for this value. */
export const PERSONAL_STATS_SCOPE = 'personal';

/** Admin global stats SWR scope — must never collide with personal keys. */
export const ADMIN_GLOBAL_STATS_SCOPE = 'admin-global';

/**
 * Explicit instant window (half-open `[startAt, endAt)`) plus an optional single-user
 * narrowing. Only the admin data source honours these; personal services ignore them.
 */
export interface StatsRangeParams {
  endAt?: string;
  startAt?: string;
  userId?: string;
}

export interface StatsCountDateParams extends StatsRangeParams {
  endDate?: string;
  range?: [string, string];
  startDate?: string;
}

/** Either a month key (`YYYY-MM`, legacy) or an explicit window. */
export type StatsUsageParams = string | (StatsRangeParams & { mo?: string });

/** Month key carried by either shape — personal services only understand this. */
export const statsUsageMonth = (params?: StatsUsageParams): string | undefined =>
  typeof params === 'string' ? params : params?.mo;

/** One row of `rankUsers` — admin-only, so it is not part of the personal contract. */
export interface StatsUserRankItem {
  avatar: string | null;
  cost: number;
  inputTokens: number;
  messages: number;
  name: string;
  outputTokens: number;
  totalTokens: number;
  userId: string;
}

export interface StatsDailyTokenTotal {
  day: string;
  totalTokens: number | string;
}

/**
 * Pluggable data source for the stats settings UI.
 * Personal mode uses existing user services; admin injects platform-wide APIs.
 *
 * Range / user params are accepted by every member so the same components can be
 * driven by the admin filter bar. Personal implementations deliberately drop them
 * (their services have no such window) — see `personalStatsDataSource`.
 */
export interface StatsDataSource {
  countAgents: (params?: StatsCountDateParams) => Promise<number>;
  countMessages: (params?: StatsCountDateParams) => Promise<number>;
  countTopics: (params?: StatsCountDateParams) => Promise<number>;
  findAndGroupByDay: (params?: StatsUsageParams) => Promise<UsageLog[]>;
  findByMonth: (params?: StatsUsageParams) => Promise<UsageRecordItem[]>;
  getHeatmaps: () => Promise<HeatmapsProps['data']>;
  getMaxTaskDuration: () => Promise<number>;
  getTokenHeatmaps: () => Promise<HeatmapsProps['data']>;
  rankAgents: (limit?: number, params?: StatsRangeParams) => Promise<AgentRankItem[]>;
  /** No limit param — matches personal `messageService.rankModels()` (server default top 10). */
  rankModels: (params?: StatsRangeParams) => Promise<ModelRankItem[]>;
  rankTopics: (limit?: number, params?: StatsRangeParams) => Promise<TopicRankItem[]>;
  /**
   * Admin-only. Absent for personal / workspace scopes, where there is nothing to rank.
   * `userId` is honoured like everywhere else: a page pinned to one user gets that user's
   * row, not a ranking of everybody inside their window.
   */
  rankUsers?: (limit?: number, params?: StatsRangeParams) => Promise<StatsUserRankItem[]>;
  /**
   * SWR cache scope. `personal` keeps historical key shapes; any other value is
   * appended to keys so admin global never shares the personal cache.
   */
  scopeKey: string;
  /**
   * Admin-only aggregate token series. Lets the token tile follow an arbitrary
   * window instead of summing the fixed calendar-year heatmap.
   */
  usageDailyTokenTotals?: (params?: StatsUsageParams) => Promise<StatsDailyTokenTotal[]>;
}

export const personalStatsDataSource: StatsDataSource = {
  countAgents: (params) => agentService.countAgents(params),
  countMessages: (params) => messageService.countMessages(params),
  countTopics: (params) => topicService.countTopics(params),
  findAndGroupByDay: (params) => usageService.findAndGroupByDay(statsUsageMonth(params)),
  findByMonth: (params) => usageService.findByMonth(statsUsageMonth(params)),
  getHeatmaps: () => messageService.getHeatmaps(),
  getMaxTaskDuration: () => topicService.getMaxTaskDuration(),
  getTokenHeatmaps: () => messageService.getTokenHeatmaps(),
  rankAgents: (limit) => agentService.rankAgents(limit),
  rankModels: () => messageService.rankModels(),
  rankTopics: (limit) => topicService.rankTopics(limit),
  scopeKey: PERSONAL_STATS_SCOPE,
};

const StatsDataSourceContext = createContext<StatsDataSource>(personalStatsDataSource);

/**
 * Inject a non-default stats data source (e.g. admin global).
 *
 * `value` must be a stable reference (module-level constant or memoized object).
 * Call sites today use module-level constants (`personalStatsDataSource`,
 * `adminGlobalStatsDataSource`).
 */
export const StatsDataSourceProvider = ({
  children,
  value,
}: {
  children: ReactNode;
  value: StatsDataSource;
}) => {
  return <StatsDataSourceContext value={value}>{children}</StatsDataSourceContext>;
};

export const useStatsDataSource = (): StatsDataSource => use(StatsDataSourceContext);

/**
 * Scope a stats SWR key. Personal scope returns the original key (zero change);
 * other scopes append the scope segment so caches never collide.
 */
export const scopeStatsKey = (key: readonly unknown[], scopeKey: string): readonly unknown[] => {
  if (!scopeKey || scopeKey === PERSONAL_STATS_SCOPE) return key;
  return [...key, scopeKey];
};

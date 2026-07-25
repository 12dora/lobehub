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

export interface StatsCountDateParams {
  endDate?: string;
  range?: [string, string];
  startDate?: string;
}

/**
 * Pluggable data source for the stats settings UI.
 * Personal mode uses existing user services; admin injects platform-wide APIs.
 */
export interface StatsDataSource {
  countAgents: (params?: StatsCountDateParams) => Promise<number>;
  countMessages: (params?: StatsCountDateParams) => Promise<number>;
  countTopics: (params?: StatsCountDateParams) => Promise<number>;
  findAndGroupByDay: (mo?: string) => Promise<UsageLog[]>;
  findByMonth: (mo?: string) => Promise<UsageRecordItem[]>;
  getHeatmaps: () => Promise<HeatmapsProps['data']>;
  getMaxTaskDuration: () => Promise<number>;
  getTokenHeatmaps: () => Promise<HeatmapsProps['data']>;
  rankAgents: (limit?: number) => Promise<AgentRankItem[]>;
  /** No limit param — matches personal `messageService.rankModels()` (server default top 10). */
  rankModels: () => Promise<ModelRankItem[]>;
  rankTopics: (limit?: number) => Promise<TopicRankItem[]>;
  /**
   * SWR cache scope. `personal` keeps historical key shapes; any other value is
   * appended to keys so admin global never shares the personal cache.
   */
  scopeKey: string;
}

export const personalStatsDataSource: StatsDataSource = {
  countAgents: (params) => agentService.countAgents(params),
  countMessages: (params) => messageService.countMessages(params),
  countTopics: (params) => topicService.countTopics(params),
  findAndGroupByDay: (mo) => usageService.findAndGroupByDay(mo),
  findByMonth: (mo) => usageService.findByMonth(mo),
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

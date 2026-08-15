'use client';

import { createContext, type ReactNode, use } from 'react';

import {
  scopeStatsKey,
  type StatsRangeParams,
  type StatsUsageParams,
  useStatsDataSource,
} from './StatsDataSource';

/**
 * Cross-cutting narrowing applied to every stats query on a page.
 *
 * Only the admin global stats page sets it. Personal and workspace stats render
 * without a provider, so the context stays empty and every call site keeps its
 * historical arguments and SWR key.
 */
export interface StatsFilter {
  /** Exclusive upper bound, ISO-8601 instant. */
  endAt?: string;
  /** Localized label of the active window (e.g. "Last 30 days") for filtered titles. */
  rangeLabel?: string;
  /** Inclusive lower bound, ISO-8601 instant. */
  startAt?: string;
  /** Restrict every metric to one user. */
  userId?: string;
}

const EMPTY_STATS_FILTER: StatsFilter = Object.freeze({});

const StatsFilterContext = createContext<StatsFilter>(EMPTY_STATS_FILTER);

export const StatsFilterProvider = ({
  children,
  value,
}: {
  children: ReactNode;
  value: StatsFilter;
}) => <StatsFilterContext value={value}>{children}</StatsFilterContext>;

export const useStatsFilter = (): StatsFilter => use(StatsFilterContext);

/** True when the filter narrows the query server-side (label alone does not). */
export const isStatsFilterActive = (filter: StatsFilter): boolean =>
  Boolean(filter.startAt || filter.endAt || filter.userId);

/**
 * Range / user params for a data-source call, or `undefined` when no filter is
 * active so legacy call sites keep passing nothing at all.
 */
export const statsFilterParams = (filter: StatsFilter): StatsRangeParams | undefined =>
  isStatsFilterActive(filter)
    ? { endAt: filter.endAt, startAt: filter.startAt, userId: filter.userId }
    : undefined;

/** Usage params: the explicit window when filtering, otherwise the month key. */
export const statsFilterUsageParams = (
  filter: StatsFilter,
  mo?: string,
): StatsUsageParams | undefined =>
  isStatsFilterActive(filter)
    ? { endAt: filter.endAt, startAt: filter.startAt, userId: filter.userId }
    : mo;

/** Extra SWR key segments — empty (no key change at all) when no filter is active. */
export const statsFilterKey = (filter: StatsFilter): unknown[] =>
  isStatsFilterActive(filter)
    ? [filter.startAt ?? null, filter.endAt ?? null, filter.userId ?? null]
    : [];

/**
 * Scope a stats SWR key by data source *and* active filter, so changing the range
 * or the selected user refetches instead of serving another window from cache.
 */
export const useStatsSwrKey = (key: readonly unknown[]): readonly unknown[] => {
  const { scopeKey } = useStatsDataSource();
  const filter = useStatsFilter();
  const scoped = scopeStatsKey(key, scopeKey);
  const suffix = statsFilterKey(filter);
  return suffix.length === 0 ? scoped : [...scoped, ...suffix];
};

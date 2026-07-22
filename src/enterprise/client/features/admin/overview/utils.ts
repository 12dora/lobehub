import dayjs from 'dayjs';

import type { UsageLog } from '@/types/usage/usageRecord';

import { OVERVIEW_WINDOW_DAYS } from './constants';

export interface DailyTokenPoint {
  day: string;
  tokens: number;
}

/**
 * Inclusive start date for the overview window (`YYYY-MM-DD`).
 * `now` is injectable for tests.
 */
export const overviewWindowStartDate = (
  days: number = OVERVIEW_WINDOW_DAYS,
  now: Date | dayjs.Dayjs = dayjs(),
): string => dayjs(now).subtract(days, 'day').startOf('day').format('YYYY-MM-DD');

/** Current calendar month key for usageFindAndGroupByDay (`YYYY-MM`). */
export const currentMonthKey = (now: Date | dayjs.Dayjs = dayjs()): string =>
  dayjs(now).format('YYYY-MM');

/**
 * Collapse usage logs into a simple daily token series for the overview area chart.
 * Days with no logs still appear when the server already returned them with zero totals.
 */
export const toDailyTokenTrend = (logs: UsageLog[] | undefined | null): DailyTokenPoint[] => {
  if (!logs?.length) return [];
  return logs.map((log) => ({
    day: log.day,
    tokens: Number(log.totalTokens) || 0,
  }));
};

/** True when there is no series or every day is zero (new deploy / idle month). */
export const isEmptyTokenTrend = (points: DailyTokenPoint[] | undefined | null): boolean => {
  if (!points?.length) return true;
  return points.every((p) => !p.tokens);
};

/** True when ranking list is missing or all counts are zero. */
export const isEmptyRank = (
  items: Array<{ count?: number | null }> | undefined | null,
): boolean => {
  if (!items?.length) return true;
  return items.every((item) => !item.count);
};

/** True when heatmap has no active days (level > 0). */
export const isEmptyHeatmap = (data: Array<{ level?: number }> | undefined | null): boolean => {
  if (!data?.length) return true;
  return data.every((item) => !item.level || item.level <= 0);
};

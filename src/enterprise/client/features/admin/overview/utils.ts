import dayjs from 'dayjs';

import { OVERVIEW_WINDOW_DAYS } from './constants';

export interface DailyTokenPoint {
  day: string;
  tokens: number;
}

/**
 * Inclusive start date for the overview window (`YYYY-MM-DD`).
 * For a "last N calendar days including today" window, subtract `days - 1`
 * (e.g. 30 days ending 2026-07-22 starts 2026-06-23).
 * `now` is injectable for tests.
 */
export const overviewWindowStartDate = (
  days: number = OVERVIEW_WINDOW_DAYS,
  now: Date | dayjs.Dayjs = dayjs(),
): string =>
  dayjs(now)
    .subtract(Math.max(days - 1, 0), 'day')
    .startOf('day')
    .format('YYYY-MM-DD');

/** Current calendar month key for usageDailyTokenTotals (`YYYY-MM`). */
export const currentMonthKey = (now: Date | dayjs.Dayjs = dayjs()): string =>
  dayjs(now).format('YYYY-MM');

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

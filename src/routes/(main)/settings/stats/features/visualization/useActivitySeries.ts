import { useTheme, useThemeMode } from 'antd-style';
import { useMemo } from 'react';

import {
  isStatsFilterActive,
  type StatsActivityBucket,
  type StatsActivityMetric,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';

import {
  type ActivityView,
  CALENDAR_MAX_LEVEL,
  resolveActivityView,
  resolveCalendarWindow,
  resolveDisplayTimeZone,
  resolveRangeDays,
} from './activity.utils';

/**
 * The one request behind the ranged activity card and its summary strip.
 *
 * A sub-48h window fetches its hours. Any longer window fetches the trailing
 * {@link CALENDAR_WEEKS}-week calendar that ends with it, and the selected days are
 * highlighted on that grid — so the chart keeps the year view's dense shape whatever
 * the range, and the summary strip reads only the highlighted days
 * ({@link useActivitySeries} exposes `range` for exactly that).
 *
 * The chart and the strip call this with the same metric and share the SWR key, so
 * the request is deduped and the two can never disagree.
 */
export const useActivitySeries = (metric: StatsActivityMetric, enabled = true) => {
  const { activitySeries } = useStatsDataSource();
  const filter = useStatsFilter();

  const ranged = enabled && Boolean(activitySeries) && isStatsFilterActive(filter);
  const view: ActivityView = ranged
    ? resolveActivityView(filter.startAt, filter.endAt)
    : 'calendar';
  const timeZone = resolveDisplayTimeZone();

  const window = useMemo(() => {
    if (!ranged) return undefined;
    if (view === 'hour') return { endAt: filter.endAt, startAt: filter.startAt };
    return resolveCalendarWindow(filter.endAt, filter.startAt);
  }, [filter.endAt, filter.startAt, ranged, view]);

  const range = useMemo(
    () => (ranged ? resolveRangeDays(filter.startAt, filter.endAt) : undefined),
    [filter.endAt, filter.startAt, ranged],
  );

  const key = useStatsSwrKey(statsKeys.activitySeries(metric, timeZone));
  const series = useClientDataSWR<StatsActivityBucket[]>(ranged && window ? key : null, () =>
    activitySeries!({
      endAt: window!.endAt,
      metric,
      startAt: window!.startAt,
      timeZone,
      userId: filter.userId,
    }),
  );

  return { filter, range, ranged, series, timeZone, view };
};

/**
 * The calendar heatmap's own colour scale for `maxLevel` {@link CALENDAR_MAX_LEVEL}:
 * level 0 plus one step per level, so every square drawn by this card — calendar,
 * hour strip, legend — means the same thing.
 */
export const useActivityLevelColors = (): string[] => {
  const theme = useTheme();
  const { isDarkMode } = useThemeMode();
  return useMemo(
    () => [
      theme.colorFillSecondary,
      isDarkMode ? theme.lime2 : theme.green2,
      isDarkMode ? theme.lime4 : theme.green4,
      isDarkMode ? theme.lime6 : theme.green6,
      isDarkMode ? theme.lime8 : theme.green8,
    ],
    [isDarkMode, theme],
  );
};

export { CALENDAR_MAX_LEVEL };

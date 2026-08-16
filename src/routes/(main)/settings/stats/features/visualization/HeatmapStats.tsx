import { Block, Flexbox, Skeleton } from '@lobehub/ui';
import { Divider } from 'antd';
import { cssVar } from 'antd-style';
import { Fragment, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import { statsFilterParams, useStatsDataSource, useStatsSwrKey } from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import { formatShortenNumber } from '@/utils/format';

import { HeatmapType } from '../../types';
import {
  activityBucketDay,
  isTerminalDayCurrent,
  rowsInRange,
  summarizeActivitySeries,
} from './activity.utils';
import { useActivitySeries } from './useActivitySeries';

/**
 * Render a wall-clock duration in seconds as a compact "1h 15m" / "15m 20s" /
 * "45s" string. Returns '--' when there is nothing to show.
 */
const formatDuration = (seconds?: number) => {
  if (!seconds || seconds < 1) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

/**
 * Token-dimension summary row for the activity card. The peak / streak figures are
 * derived from the very series the chart above draws (same SWR key, so the request
 * is deduped) — unfiltered that is the calendar-year token heatmap, filtered it is
 * the ranged activity series, so the two can never contradict each other.
 * The cumulative token total lives in the overview cards above, so it is
 * intentionally not repeated here.
 */
const HeatmapStats = memo(() => {
  const { t } = useTranslation('auth');
  const { getMaxTaskDuration, getTokenHeatmaps } = useStatsDataSource();
  const { filter, range, ranged, series, timeZone, view } = useActivitySeries(HeatmapType.Tokens);
  const yearKey = useStatsSwrKey(statsKeys.heatmaps(HeatmapType.Tokens));
  const durationKey = useStatsSwrKey(statsKeys.maxTaskDuration());

  const year = useClientDataSWR(ranged ? null : yearKey, () => getTokenHeatmaps());

  const active = ranged ? series : year;
  // A terminal failure is neither loading nor settled — treating "no data" as loading
  // is what leaves the tiles on a skeleton forever.
  const loading = active.isLoading || (active.data === undefined && !active.error);

  const duration = useClientDataSWR(durationKey, () =>
    getMaxTaskDuration(statsFilterParams(filter)),
  );
  const durationLoading = duration.isLoading || (duration.data === undefined && !duration.error);

  const stats = useMemo(() => {
    // Ranged, the series is the whole trailing calendar; only the selected days count.
    const rows = ranged
      ? rowsInRange(series.data, range).map((row) => ({
          count: row.count,
          day: activityBucketDay(row.bucket),
        }))
      : year.data?.map((row) => ({ count: row.count, day: row.date }));
    // A zero-valued last day only means "not over yet" when it really is today; a
    // closed historical window ending on an inactive day has no current streak.
    return summarizeActivitySeries(rows, {
      isTerminalDayCurrent: isTerminalDayCurrent(rows, timeZone),
    });
  }, [range, ranged, series.data, timeZone, year.data]);

  const days = (n: number) => [n, t('stats.days')].join(' ');

  // Streaks are a day-over-day story; on an hourly window there are at most two days
  // to count, so the tiles would print noise instead of an insight.
  const showStreaks = view !== 'hour';

  const seriesTile = {
    data: active.data,
    error: active.error,
    loading,
    onRetry: () => active.mutate(),
  };

  const items = [
    {
      ...seriesTile,
      label: t(
        view === 'hour' ? 'stats.heatmapStats.peakHourlyTokens' : 'stats.heatmapStats.peakTokens',
      ),
      value: formatShortenNumber(stats.peak),
    },
    {
      data: duration.data,
      error: duration.error,
      label: t('stats.heatmapStats.longestTask'),
      loading: durationLoading,
      onRetry: () => duration.mutate(),
      value: formatDuration(duration.data),
    },
    ...(showStreaks
      ? [
          {
            ...seriesTile,
            label: t('stats.heatmapStats.currentStreak'),
            value: days(stats.current),
          },
          {
            ...seriesTile,
            label: t('stats.heatmapStats.longestStreak'),
            value: days(stats.longest),
          },
        ]
      : []),
  ];

  return (
    <Block paddingBlock={16} paddingInline={8} variant={'outlined'}>
      <Flexbox horizontal align={'center'} width={'100%'}>
        {items.map((item, index) => (
          <Fragment key={item.label}>
            {index > 0 && <Divider style={{ height: 32, margin: 0 }} type={'vertical'} />}
            <Flexbox align={'center'} flex={1} gap={4}>
              <div style={{ fontSize: 20, fontWeight: 'bold' }}>
                <AsyncBoundary
                  data={item.data}
                  error={item.error}
                  errorVariant={'metric'}
                  isLoading={item.loading}
                  loading={<Skeleton.Button active size={'small'} style={{ width: 56 }} />}
                  onRetry={item.onRetry}
                >
                  {item.value}
                </AsyncBoundary>
              </div>
              <div style={{ color: cssVar.colorTextDescription, fontSize: 12 }}>{item.label}</div>
            </Flexbox>
          </Fragment>
        ))}
      </Flexbox>
    </Block>
  );
});

export default HeatmapStats;

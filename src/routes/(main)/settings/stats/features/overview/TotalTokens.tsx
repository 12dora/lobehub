import dayjs from 'dayjs';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import Statistic from '@/components/Statistic';
import StatisticCard from '@/components/StatisticCard';
import TitleWithPercentage from '@/components/StatisticCard/TitleWithPercentage';
import {
  statsFilterUsageParams,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import { formatShortenNumber } from '@/utils/format';
import { lastMonth } from '@/utils/time';

import { HeatmapType } from '../../types';
import TotalCard from './ShareButton/TotalCard';

/**
 * Cumulative token count.
 *
 * Unfiltered, it is derived from the daily token-heatmap series (same SWR key as
 * the heatmap, so the request is deduped): `count` sums the whole window and
 * `prevCount` sums up to the end of last month for the month-over-month delta.
 *
 * With an explicit window active it sums the aggregate daily-token series for that
 * window instead — the heatmap is fixed to the trailing calendar year and would
 * ignore the filter. The month-over-month delta is dropped there, because an
 * arbitrary window has no "last month" to compare against.
 */
const TotalTokens = memo<{ inShare?: boolean }>(({ inShare }) => {
  const { t } = useTranslation('auth');
  const { getTokenHeatmaps, usageDailyTokenTotals } = useStatsDataSource();
  const filter = useStatsFilter();
  const usageParams = statsFilterUsageParams(filter);
  const ranged = Boolean(usageParams && usageDailyTokenTotals);

  const heatmapKey = useStatsSwrKey(statsKeys.heatmaps(HeatmapType.Tokens));
  const dailyKey = useStatsSwrKey(statsKeys.dailyTokens());

  const heatmaps = useClientDataSWR(ranged ? null : heatmapKey, () => getTokenHeatmaps());
  const daily = useClientDataSWR(ranged ? dailyKey : null, () =>
    usageDailyTokenTotals!(usageParams),
  );

  const source = ranged ? daily : heatmaps;

  const { count, prevCount } = useMemo(() => {
    if (ranged) {
      const total = (daily.data ?? []).reduce(
        (acc, row) => acc + (Number(row.totalTokens) || 0),
        0,
      );
      return { count: total, prevCount: undefined };
    }

    if (!heatmaps.data?.length) return { count: 0, prevCount: 0 };

    const lastMonthEnd = lastMonth();
    let count = 0;
    let prevCount = 0;
    for (const item of heatmaps.data) {
      count += item.count;
      if (!dayjs(item.date).isAfter(lastMonthEnd)) prevCount += item.count;
    }
    return { count, prevCount };
  }, [ranged, daily.data, heatmaps.data]);

  if (inShare)
    return (
      <TotalCard
        count={formatShortenNumber(prevCount) || '--'}
        title={t('stats.heatmapStats.totalTokens')}
      />
    );

  // Metric variant: a failed fetch must never fall through to a confident `$0`
  // — show a failed marker + Retry where the number would sit (ux Read §1.1).
  return (
    <AsyncBoundary
      data={source.data}
      error={source.error}
      errorVariant={'metric'}
      onRetry={() => source.mutate()}
    >
      <StatisticCard
        loading={source.isLoading || !source.data}
        statistic={{
          description:
            prevCount === undefined ? undefined : (
              <Statistic
                title={t('date.prevMonth')}
                value={formatShortenNumber(prevCount) || '--'}
              />
            ),
          precision: 0,
          style: {
            fontWeight: 'bold',
          },
          value: formatShortenNumber(count) || '--',
        }}
        title={
          <TitleWithPercentage
            count={count}
            prvCount={prevCount}
            title={t('stats.heatmapStats.totalTokens')}
          />
        }
      />
    </AsyncBoundary>
  );
});

export default TotalTokens;

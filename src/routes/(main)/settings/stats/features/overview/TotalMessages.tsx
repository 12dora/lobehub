import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import Statistic from '@/components/Statistic';
import StatisticCard from '@/components/StatisticCard';
import TitleWithPercentage from '@/components/StatisticCard/TitleWithPercentage';
import {
  statsFilterParams,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import { formatIntergerNumber } from '@/utils/format';
import { lastMonth } from '@/utils/time';

import TotalCard from './ShareButton/TotalCard';

const TotalMessages = memo<{ inShare?: boolean; mobile?: boolean }>(({ inShare }) => {
  const { t } = useTranslation('auth');
  const { countMessages } = useStatsDataSource();
  const params = statsFilterParams(useStatsFilter());
  const swrKey = useStatsSwrKey(statsKeys.messages());
  const { data, isLoading, error, mutate } = useClientDataSWR(swrKey, async () => ({
    count: await countMessages(params),
    // A month-over-month delta is meaningless against an arbitrary window, so the
    // comparison is dropped while a filter is active rather than shown as a wrong number.
    prevCount: params
      ? undefined
      : await countMessages({ endDate: lastMonth().format('YYYY-MM-DD') }),
  }));

  if (inShare)
    return (
      <TotalCard
        count={formatIntergerNumber(data?.prevCount) || '--'}
        title={t('stats.messages')}
      />
    );

  return (
    <AsyncBoundary data={data} error={error} errorVariant={'metric'} onRetry={() => mutate()}>
      <StatisticCard
        loading={isLoading || !data}
        statistic={{
          description:
            data?.prevCount === undefined ? undefined : (
              <Statistic
                title={t('date.prevMonth')}
                value={formatIntergerNumber(data?.prevCount) || '--'}
              />
            ),
          precision: 0,
          value: data?.count || '--',
        }}
        title={
          <TitleWithPercentage
            count={data?.count}
            prvCount={data?.prevCount}
            title={t('stats.messages')}
          />
        }
      />
    </AsyncBoundary>
  );
});

export default TotalMessages;

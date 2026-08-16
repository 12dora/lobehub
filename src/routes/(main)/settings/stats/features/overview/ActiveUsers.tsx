import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import StatisticCard from '@/components/StatisticCard';
import {
  statsFilterParams,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';

/**
 * Users active inside the selected window — admin-only. Shares the SWR key with
 * {@link TotalUsers}, so both tiles come from one request.
 */
const ActiveUsers = memo(() => {
  const { t } = useTranslation('auth');
  const { userTotals } = useStatsDataSource();
  const params = statsFilterParams(useStatsFilter());
  const swrKey = useStatsSwrKey(statsKeys.userTotals());

  const { data, isLoading, error, mutate } = useClientDataSWR(userTotals ? swrKey : null, () =>
    userTotals!(params),
  );

  return (
    <AsyncBoundary data={data} error={error} errorVariant={'metric'} onRetry={() => mutate()}>
      <StatisticCard
        loading={isLoading || !data}
        statistic={{ precision: 0, value: data?.usersActive ?? '--' }}
        title={t('stats.usersActive')}
      />
    </AsyncBoundary>
  );
});

export default ActiveUsers;

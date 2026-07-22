'use client';

import { AreaChart } from '@lobehub/charts';
import { Skeleton } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatTokenNumber } from '@/utils/format';

import { overviewStyles as styles } from './styles';
import { useOverviewUsageTrend } from './useOverviewStats';
import { isEmptyTokenTrend } from './utils';

const UsageTrendCard = memo(() => {
  const { t } = useTranslation('admin');
  const { data, isLoading } = useOverviewUsageTrend();
  const loading = isLoading || !data;
  const empty = !loading && isEmptyTokenTrend(data);
  // Localized series key so chart tooltip / legend never show bare English "tokens".
  const seriesName = t('overview.usageTrend.series');
  const chartData = (data ?? []).map((point) => ({
    day: point.day,
    [seriesName]: point.tokens,
  }));

  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>{t('overview.usage.title')}</h2>
      {loading ? (
        <Skeleton.Block active height={220} width="100%" />
      ) : empty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{t('overview.usage.emptyTitle')}</p>
          <p className={styles.emptyDesc}>{t('overview.usage.emptyDesc')}</p>
        </div>
      ) : (
        <AreaChart
          categories={[seriesName]}
          data={chartData}
          index="day"
          showLegend={false}
          valueFormatter={(num) => formatTokenNumber(num)}
          yAxisWidth={48}
        />
      )}
    </section>
  );
});

UsageTrendCard.displayName = 'AdminOverviewUsageTrendCard';

export default UsageTrendCard;

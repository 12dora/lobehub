'use client';

import { AreaChart } from '@lobehub/charts';
import { Alert, Skeleton } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatTokenNumber } from '@/utils/format';

import { overviewStyles as styles } from './styles';
import { useOverviewUsageTrend } from './useOverviewStats';
import { isEmptyTokenTrend } from './utils';

const UsageTrendCard = memo(() => {
  const { t } = useTranslation('admin');
  const { data, error, isLoading, mutate } = useOverviewUsageTrend();
  const loading = isLoading && !data;
  // Emptiness is independent of a stale-refresh error (after the initial-error
  // early return). Gating on `!error` forced a blank AreaChart for empty stale data.
  const empty = !loading && isEmptyTokenTrend(data);
  // Localized series key so chart tooltip / legend never show bare English "tokens".
  const seriesName = t('overview.usageTrend.series');
  const chartData = (data ?? []).map((point) => ({
    day: point.day,
    [seriesName]: point.tokens,
  }));

  if (error && !data) {
    return (
      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>{t('overview.usage.title')}</h2>
        <Alert
          showIcon
          description={t('overview.error.loadFailedDescription')}
          message={t('overview.error.loadFailed')}
          type="error"
          action={
            <Button size="small" onClick={() => void mutate()}>
              {t('overview.error.retry')}
            </Button>
          }
        />
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>{t('overview.usage.title')}</h2>
      {error && data ? (
        <Alert
          showIcon
          description={t('overview.error.refreshFailedDescription')}
          message={t('overview.error.refreshFailed')}
          type="warning"
          action={
            <Button size="small" onClick={() => void mutate()}>
              {t('overview.error.retry')}
            </Button>
          }
        />
      ) : null}
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

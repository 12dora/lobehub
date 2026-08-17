'use client';

import { AreaChart } from '@lobehub/charts';
import { Skeleton } from '@lobehub/ui';
import { useReducedMotion } from 'motion/react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatTokenNumber } from '@/utils/format';

import type { AdminTimeRange } from '../primitives/timeRange.utils';
import { OverviewLoadErrorAlert, OverviewRefreshWarningAlert } from './OverviewAlerts';
import OverviewCardState from './OverviewCardState';
import { overviewStyles as styles } from './styles';
import { overviewCardState } from './useOverviewCardState';
import { useOverviewUsageTrend } from './useOverviewStats';
import { isEmptyTokenTrend } from './utils';

interface UsageTrendCardProps {
  range?: AdminTimeRange;
}

const UsageTrendCard = memo<UsageTrendCardProps>(({ range }) => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  const { data, error, isLoading, mutate } = useOverviewUsageTrend(range);
  // Emptiness is independent of a stale-refresh error (after the initial-error
  // early return). Gating on `!error` forced a blank AreaChart for empty stale data.
  const state = overviewCardState({
    data,
    empty: isEmptyTokenTrend(data),
    error,
    isLoading,
  });
  // Localized series key so chart tooltip / legend never show bare English "tokens".
  const seriesName = t('overview.usageTrend.series');
  const chartData = (data ?? []).map((point) => ({
    day: point.day,
    [seriesName]: point.tokens,
  }));

  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>
        {t('overview.usage.title', { scope: range?.label ?? '' })}
      </h2>
      {state.staleError ? <OverviewRefreshWarningAlert onRetry={() => void mutate()} /> : null}
      <OverviewCardState stateKey={state.stateKey}>
        {state.loading ? (
          <Skeleton.Block active={!reduceMotion} height={220} width="100%" />
        ) : state.firstError ? (
          <OverviewLoadErrorAlert onRetry={() => void mutate()} />
        ) : state.empty ? (
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
      </OverviewCardState>
    </section>
  );
});

UsageTrendCard.displayName = 'AdminOverviewUsageTrendCard';

export default UsageTrendCard;

'use client';

import { Alert, Skeleton } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { moderationStyles as styles } from '../styles';

export interface ChartCardProps {
  children: ReactNode;
  empty: boolean;
  /** First-load failure (no stale data to fall back on). */
  error: boolean;
  loading: boolean;
  onRetry: () => void;
  title: string;
}

/**
 * One card = one chart, with the four states DESIGN.md asks for: skeleton while loading,
 * a named empty state, a retryable error, and the chart itself. Never an empty axis.
 */
const ChartCard = memo<ChartCardProps>(({ children, empty, error, loading, onRetry, title }) => {
  const { t } = useTranslation('admin');

  return (
    <section className={styles.card}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {loading ? <Skeleton.Block height={220} width="100%" /> : null}
      {!loading && error ? (
        <Alert
          showIcon
          message={t('contentModeration.charts.loadFailed')}
          type="error"
          action={
            <Button size="small" onClick={onRetry}>
              {t('contentModeration.charts.retry')}
            </Button>
          }
        />
      ) : null}
      {!loading && !error && empty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{t('contentModeration.charts.emptyTitle')}</p>
          <p className={styles.emptyDesc}>{t('contentModeration.charts.emptyDesc')}</p>
        </div>
      ) : null}
      {!loading && !error && !empty ? children : null}
    </section>
  );
});

ChartCard.displayName = 'ModerationChartCard';

export default ChartCard;

'use client';

import { Alert, Skeleton } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useReducedMotion } from 'motion/react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatIntergerNumber } from '@/utils/format';

import type { AdminTimeRange } from '../primitives/timeRange.utils';
import OverviewCardState from './OverviewCardState';
import { overviewStyles as styles } from './styles';
import { useOverviewKpis } from './useOverviewStats';

interface KpiTileProps {
  label: string;
  loading?: boolean;
  value?: number;
}

const KpiTile = memo<KpiTileProps>(({ label, value, loading }) => {
  const reduceMotion = useReducedMotion();
  const stateKey = loading ? 'loading' : 'value';

  return (
    <div className={styles.kpiTile}>
      <OverviewCardState stateKey={stateKey}>
        {loading ? (
          <Skeleton.Button active={!reduceMotion} size="small" style={{ height: 28, width: 72 }} />
        ) : (
          <span className={styles.kpiValue}>{formatIntergerNumber(value)}</span>
        )}
      </OverviewCardState>
      <span className={styles.kpiLabel}>{label}</span>
    </div>
  );
});

KpiTile.displayName = 'AdminOverviewKpiTile';

interface KpiRowProps {
  range?: AdminTimeRange;
}

const KpiRow = memo<KpiRowProps>(({ range }) => {
  const { t } = useTranslation('admin');
  const { data, error, isLoading, mutate } = useOverviewKpis(range);
  const loading = isLoading && !data;
  const scope = range?.label ?? '';

  if (error && !data) {
    return (
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
    );
  }

  return (
    <div className={styles.stack}>
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
      <div className={styles.kpiGrid}>
        <KpiTile label={t('overview.kpi.usersTotal')} loading={loading} value={data?.usersTotal} />
        <KpiTile
          label={t('overview.kpi.usersActive', { scope })}
          loading={loading}
          value={data?.usersActive}
        />
        <KpiTile
          label={t('overview.kpi.messages', { scope })}
          loading={loading}
          value={data?.messages}
        />
        <KpiTile
          label={t('overview.kpi.topics', { scope })}
          loading={loading}
          value={data?.topics}
        />
        <KpiTile
          label={t('overview.kpi.agents', { scope })}
          loading={loading}
          value={data?.agents}
        />
      </div>
      <span className={styles.scopeNote}>{t('overview.scope.note', { scope })}</span>
    </div>
  );
});

KpiRow.displayName = 'AdminOverviewKpiRow';

export default KpiRow;

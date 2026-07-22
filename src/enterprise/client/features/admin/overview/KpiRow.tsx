'use client';

import { Skeleton } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatIntergerNumber } from '@/utils/format';

import { OVERVIEW_WINDOW_DAYS } from './constants';
import { overviewStyles as styles } from './styles';
import { useOverviewKpis } from './useOverviewStats';

interface KpiTileProps {
  label: string;
  loading?: boolean;
  value?: number;
}

const KpiTile = memo<KpiTileProps>(({ label, value, loading }) => (
  <div className={styles.kpiTile}>
    {loading ? (
      <Skeleton.Button active size="small" style={{ height: 28, width: 72 }} />
    ) : (
      <span className={styles.kpiValue}>{formatIntergerNumber(value)}</span>
    )}
    <span className={styles.kpiLabel}>{label}</span>
  </div>
));

KpiTile.displayName = 'AdminOverviewKpiTile';

const KpiRow = memo(() => {
  const { t } = useTranslation('admin');
  const { data, isLoading } = useOverviewKpis();
  const loading = isLoading || !data;
  const scope = t('overview.scope.days', { days: OVERVIEW_WINDOW_DAYS });

  return (
    <div className={styles.stack}>
      <div className={styles.kpiGrid}>
        <KpiTile label={t('overview.kpi.usersTotal')} loading={loading} value={data?.usersTotal} />
        <KpiTile
          label={t('overview.kpi.usersActive', { days: OVERVIEW_WINDOW_DAYS })}
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
      <span className={styles.scopeNote}>
        {t('overview.scope.note', { days: OVERVIEW_WINDOW_DAYS })}
      </span>
    </div>
  );
});

KpiRow.displayName = 'AdminOverviewKpiRow';

export default KpiRow;

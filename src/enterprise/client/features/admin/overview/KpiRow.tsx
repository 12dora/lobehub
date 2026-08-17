'use client';

import { Skeleton } from '@lobehub/ui';
import { useReducedMotion } from 'motion/react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatIntergerNumber } from '@/utils/format';

import type { AdminTimeRange } from '../primitives/timeRange.utils';
import { OverviewLoadErrorAlert, OverviewRefreshWarningAlert } from './OverviewAlerts';
import OverviewCardState from './OverviewCardState';
import { overviewStyles as styles } from './styles';
import { overviewCardState } from './useOverviewCardState';
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
  const state = overviewCardState({ data, empty: false, error, isLoading });
  const scope = range?.label ?? '';

  if (state.firstError) {
    return <OverviewLoadErrorAlert onRetry={() => void mutate()} />;
  }

  return (
    <div className={styles.stack}>
      {state.staleError ? <OverviewRefreshWarningAlert onRetry={() => void mutate()} /> : null}
      <div className={styles.kpiGrid}>
        <KpiTile
          label={t('overview.kpi.usersTotal')}
          loading={state.loading}
          value={data?.usersTotal}
        />
        <KpiTile
          label={t('overview.kpi.usersActive', { scope })}
          loading={state.loading}
          value={data?.usersActive}
        />
        <KpiTile
          label={t('overview.kpi.messages', { scope })}
          loading={state.loading}
          value={data?.messages}
        />
        <KpiTile
          label={t('overview.kpi.topics', { scope })}
          loading={state.loading}
          value={data?.topics}
        />
        <KpiTile
          label={t('overview.kpi.agents', { scope })}
          loading={state.loading}
          value={data?.agents}
        />
      </div>
      <span className={styles.scopeNote}>{t('overview.scope.note', { scope })}</span>
    </div>
  );
});

KpiRow.displayName = 'AdminOverviewKpiRow';

export default KpiRow;

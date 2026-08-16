'use client';

import { Skeleton } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ContentModerationOverview,
  ContentModerationStatsOutput,
} from '@/types/platform/contentModeration';

import { formatLatency } from '../format';
import { moderationStyles as styles } from '../styles';

export interface KpiRowProps {
  kpi?: ContentModerationStatsOutput['kpi'];
  loading: boolean;
  /** `observe` adds the 拟处置 tiles — they are meaningless once enforcement is on. */
  mode?: ContentModerationOverview['mode'];
}

const formatCount = (value: number | undefined): string =>
  typeof value === 'number' ? value.toLocaleString() : '—';

/**
 * KPI tiles for the selected window (design §6.1). In observe mode the row grows two
 * "would have" tiles so an operator can size the blast radius before switching to enforce.
 */
const KpiRow = memo<KpiRowProps>(({ kpi, loading, mode }) => {
  const { t } = useTranslation('admin');

  const tiles: { key: string; label: string; value: string }[] = [
    { key: 'total', label: t('contentModeration.kpi.total'), value: formatCount(kpi?.total) },
    { key: 'allow', label: t('contentModeration.kpi.allow'), value: formatCount(kpi?.allow) },
    { key: 'log', label: t('contentModeration.kpi.log'), value: formatCount(kpi?.log) },
    {
      key: 'downgrade',
      label: t('contentModeration.kpi.downgrade'),
      value: formatCount(kpi?.downgrade),
    },
    { key: 'block', label: t('contentModeration.kpi.block'), value: formatCount(kpi?.block) },
    { key: 'error', label: t('contentModeration.kpi.error'), value: formatCount(kpi?.error) },
    {
      key: 'avgLatency',
      label: t('contentModeration.kpi.avgLatency'),
      value: formatLatency(kpi?.avgLatencyMs),
    },
  ];

  if (mode === 'observe') {
    tiles.push(
      {
        key: 'wouldDowngrade',
        label: t('contentModeration.kpi.wouldDowngrade'),
        value: formatCount(kpi?.wouldDowngrade),
      },
      {
        key: 'wouldBlock',
        label: t('contentModeration.kpi.wouldBlock'),
        value: formatCount(kpi?.wouldBlock),
      },
    );
  }

  return (
    <div className={styles.kpiGrid}>
      {tiles.map((tile) => (
        <div className={styles.kpiTile} data-testid={`moderation-kpi-${tile.key}`} key={tile.key}>
          <span className={styles.kpiLabel}>{tile.label}</span>
          {loading ? (
            <Skeleton.Block height={26} width={64} />
          ) : (
            <span className={styles.kpiValue}>{tile.value}</span>
          )}
        </div>
      ))}
    </div>
  );
});

KpiRow.displayName = 'ModerationKpiRow';

export default KpiRow;

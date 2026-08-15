'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { adminGlobalStatsDataSource } from '@/enterprise/client/features/admin/stats/adminStatsDataSource';
import { StatsDataSourceProvider } from '@/features/SettingsStats';
import { AiHeatmaps } from '@/routes/(main)/settings/stats/features/visualization';

import { overviewStyles as styles } from './styles';

/**
 * Platform activity heatmap — reuses the user-settings AiHeatmaps component
 * with the admin global stats data source injected via context (parity pattern).
 * Title, type switch (messages / tokens), and empty/loading states come from AiHeatmaps.
 *
 * The heatmap always spans the trailing calendar year, so it deliberately ignores
 * the page time-range filter; the caption says so rather than letting the card
 * look stale next to the filtered cards.
 */
const HeatmapCard = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <section className={styles.card}>
      <StatsDataSourceProvider value={adminGlobalStatsDataSource}>
        <AiHeatmaps />
      </StatsDataSourceProvider>
      <span className={styles.scopeNote}>{t('overview.heatmap.unfilteredNote')}</span>
    </section>
  );
});

HeatmapCard.displayName = 'AdminOverviewHeatmapCard';

export default HeatmapCard;

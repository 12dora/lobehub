'use client';

import { memo } from 'react';

import { adminGlobalStatsDataSource } from '@/enterprise/client/features/admin/stats/adminStatsDataSource';
import { StatsDataSourceProvider } from '@/features/SettingsStats';
import { AiHeatmaps } from '@/routes/(main)/settings/stats/features/visualization';

import { overviewStyles as styles } from './styles';

/**
 * Platform activity heatmap — reuses the user-settings AiHeatmaps component
 * with the admin global stats data source injected via context (parity pattern).
 * Title, type switch (messages / tokens), and empty/loading states come from AiHeatmaps.
 */
const HeatmapCard = memo(() => {
  return (
    <section className={styles.card}>
      <StatsDataSourceProvider value={adminGlobalStatsDataSource}>
        <AiHeatmaps />
      </StatsDataSourceProvider>
    </section>
  );
});

HeatmapCard.displayName = 'AdminOverviewHeatmapCard';

export default HeatmapCard;

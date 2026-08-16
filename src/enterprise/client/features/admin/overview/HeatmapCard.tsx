'use client';

import { memo, useMemo } from 'react';

import { adminGlobalStatsDataSource } from '@/enterprise/client/features/admin/stats/adminStatsDataSource';
import {
  StatsDataSourceProvider,
  type StatsFilter,
  StatsFilterProvider,
} from '@/features/SettingsStats';
import { AiHeatmaps } from '@/routes/(main)/settings/stats/features/visualization';

import type { AdminTimeRange } from '../primitives/timeRange.utils';
import { overviewStyles as styles } from './styles';

interface HeatmapCardProps {
  /** Active time-range filter — the activity card follows it like every other card. */
  range?: AdminTimeRange;
}

/**
 * Platform activity card — reuses the user-settings AiHeatmaps component with the
 * admin global stats data source injected via context (parity pattern). Title, type
 * switch (messages / tokens), and empty/loading states come from AiHeatmaps.
 *
 * The page range travels with it through `StatsFilterProvider`, so the card answers
 * for the same window as the KPI tiles instead of a fixed trailing year.
 */
const HeatmapCard = memo<HeatmapCardProps>(({ range }) => {
  const filter = useMemo<StatsFilter>(
    () => ({ endAt: range?.endAt, rangeLabel: range?.label, startAt: range?.startAt }),
    [range?.endAt, range?.label, range?.startAt],
  );

  return (
    <section className={styles.card}>
      <StatsDataSourceProvider value={adminGlobalStatsDataSource}>
        <StatsFilterProvider value={filter}>
          <AiHeatmaps />
        </StatsFilterProvider>
      </StatsDataSourceProvider>
    </section>
  );
});

HeatmapCard.displayName = 'AdminOverviewHeatmapCard';

export default HeatmapCard;

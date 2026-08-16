'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import type { AdminTimeRange } from '../primitives/timeRange.utils';
import HeatmapCard from './HeatmapCard';
import KpiRow from './KpiRow';
import QuickLinks from './QuickLinks';
import RankCards from './RankCards';
import { overviewStyles as styles } from './styles';
import UsageTrendCard from './UsageTrendCard';

interface OverviewDashboardProps {
  /** Active time-range filter; every card follows it. */
  range?: AdminTimeRange;
}

/**
 * Admin /admin overview dashboard body.
 * Assembles KPI tiles, usage trend, heatmap, rankings, and quick links.
 */
const OverviewDashboard = memo<OverviewDashboardProps>(({ range }) => {
  return (
    <Flexbox className={styles.stack} gap={16}>
      <KpiRow range={range} />
      {/* Both charts get a full-width row: a calendar strip clipped by a half-width
          column had no scrollbar, so the later months were simply unreachable. */}
      <UsageTrendCard range={range} />
      <HeatmapCard range={range} />
      <RankCards range={range} />
      <QuickLinks />
    </Flexbox>
  );
});

OverviewDashboard.displayName = 'AdminOverviewDashboard';

export default OverviewDashboard;

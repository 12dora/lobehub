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
  /** Active time-range filter; every card except the calendar-year heatmap follows it. */
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
      <div className={styles.mainGrid}>
        <UsageTrendCard range={range} />
        <HeatmapCard />
      </div>
      <RankCards range={range} />
      <QuickLinks />
    </Flexbox>
  );
});

OverviewDashboard.displayName = 'AdminOverviewDashboard';

export default OverviewDashboard;

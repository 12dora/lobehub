'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import HeatmapCard from './HeatmapCard';
import KpiRow from './KpiRow';
import QuickLinks from './QuickLinks';
import RankCards from './RankCards';
import { overviewStyles as styles } from './styles';
import UsageTrendCard from './UsageTrendCard';

/**
 * Admin /admin overview dashboard body.
 * Assembles KPI tiles, usage trend, heatmap, rankings, and quick links.
 */
const OverviewDashboard = memo(() => {
  return (
    <Flexbox className={styles.stack} gap={16}>
      <KpiRow />
      <div className={styles.mainGrid}>
        <UsageTrendCard />
        <HeatmapCard />
      </div>
      <RankCards />
      <QuickLinks />
    </Flexbox>
  );
});

OverviewDashboard.displayName = 'AdminOverviewDashboard';

export default OverviewDashboard;

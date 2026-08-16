import { BarChart } from '@lobehub/charts';
import { memo, useMemo } from 'react';

import type { StatsActivityBucket } from '@/features/SettingsStats';
import { formatIntergerNumber, formatShortenNumber } from '@/utils/format';

import { activitySpansDays, type ActivityView, formatActivityBucketLabel } from './activity.utils';

interface ActivityBarChartProps {
  data?: StatsActivityBucket[];
  loading?: boolean;
  /** Localized series name — drives the tooltip row, never a bare English key. */
  seriesName: string;
  /** Tokens are shortened (1.2M), message counts are printed in full. */
  showTokens?: boolean;
  view: Exclude<ActivityView, 'calendar'>;
}

/**
 * Short-window activity as bars.
 *
 * Bars plot the raw `count`, never the heatmap `level`: `level` is scaled against the
 * busiest bucket in the window, so on a 24-hour window the loudest hour would always
 * be full height and every bar would lie about its size.
 */
const ActivityBarChart = memo<ActivityBarChartProps>(
  ({ data, loading, seriesName, showTokens, view }) => {
    // An hourly window may straddle midnight, where a bare `HH:00` is ambiguous and
    // — for the same hour on both days — a duplicate x-axis index.
    const withDate = view === 'hour' && activitySpansDays(data);

    const chartData = useMemo(
      () =>
        (data ?? []).map((row) => ({
          bucket: formatActivityBucketLabel(row.bucket, view, withDate),
          [seriesName]: row.count,
        })),
      [data, seriesName, view, withDate],
    );

    return (
      <BarChart
        categories={[seriesName]}
        data={chartData}
        height={200}
        index={'bucket'}
        loading={loading}
        showLegend={false}
        yAxisWidth={48}
        valueFormatter={(value) =>
          String(showTokens ? formatShortenNumber(value) : formatIntergerNumber(value))
        }
      />
    );
  },
);

ActivityBarChart.displayName = 'ActivityBarChart';

export default ActivityBarChart;

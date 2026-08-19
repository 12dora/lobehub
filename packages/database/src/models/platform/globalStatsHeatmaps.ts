/**
 * Calendar-day zero-fill shared by the two platform-stats year heatmaps.
 */
import type { HeatmapsProps } from '@lobehub/charts';
import type { Dayjs } from 'dayjs';

export const fillCalendarHeatmap = ({
  endDate,
  levelOf,
  startDate,
  values,
}: {
  endDate: Dayjs;
  levelOf: (value: number) => number;
  startDate: Dayjs;
  values: Map<string, number>;
}): HeatmapsProps['data'] => {
  const heatmapData: HeatmapsProps['data'] = [];
  let currentDate = startDate.clone();

  while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, 'day')) {
    const formattedDate = currentDate.format('YYYY-MM-DD');
    const dayCount = values.get(formattedDate) || 0;

    heatmapData.push({
      count: dayCount,
      date: formattedDate,
      level: levelOf(dayCount),
    });

    currentDate = currentDate.add(1, 'day');
  }

  return heatmapData;
};

import { Flexbox } from '@lobehub/ui';
import dayjs from 'dayjs';
import { memo } from 'react';

import { useStatsFilter } from '@/features/SettingsStats';

import { type UsageChartProps } from '../../../types';
import ActiveModels from './ActiveModels';
import MonthSpend from './MonthSpend';
import TodaySpend from './TodaySpend';

const UsageCards = memo<UsageChartProps>(({ isLoading, data, groupBy, resolveUser }) => {
  const { endAt } = useStatsFilter();
  // "Today" would always read $0 for a window that already ended — drop the card instead
  // of showing a confident zero (ux Read §1.1). The test is calendar-day inclusion: the
  // window is half-open, so its last included day is the day at `endAt - 1ms`. Comparing
  // the live clock with `endAt` instead would hide the card for *every* preset, because
  // `endAt` is frozen at selection time and the clock passes it within a millisecond.
  const showToday = !endAt || dayjs(endAt).subtract(1, 'millisecond').isSame(dayjs(), 'day');

  return (
    <Flexbox horizontal gap={16}>
      {showToday ? <TodaySpend data={data} isLoading={isLoading} /> : null}
      <MonthSpend data={data} isLoading={isLoading} />
      <ActiveModels data={data} groupBy={groupBy} isLoading={isLoading} resolveUser={resolveUser} />
    </Flexbox>
  );
});

export default UsageCards;

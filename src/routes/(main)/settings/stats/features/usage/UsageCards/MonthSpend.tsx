'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import Statistic from '@/components/Statistic';
import StatisticCard from '@/components/StatisticCard';
import TitleWithPercentage from '@/components/StatisticCard/TitleWithPercentage';
import { useStatsFilter } from '@/features/SettingsStats';
import { type UsageLog } from '@/types/usage/usageRecord';
import { formatNumber } from '@/utils/format';

import { type UsageChartProps } from '../../../types';

const computeMonth = (
  data: UsageLog[],
): {
  calls: number | string;
  spend: number | string;
} => {
  if (!data || data?.length === 0) return { calls: 0, spend: 0 };

  const spend = data.reduce((acc, log) => acc + (log.totalSpend || 0), 0);
  const calls = data.reduce((acc, log) => acc + (log.records?.length ?? 0), 0);

  return {
    calls: formatNumber(calls),
    spend: formatNumber(spend),
  };
};

const MonthSpend = memo<UsageChartProps>(({ data, isLoading }) => {
  const { t } = useTranslation('auth');
  const { rangeLabel } = useStatsFilter();

  const { spend, calls } = computeMonth(data || []);
  // The card sums whatever window is loaded — say which one instead of claiming "this month".
  const title = rangeLabel
    ? t('usage.cards.month.titleInRange', { range: rangeLabel })
    : t('usage.cards.month.title');

  return (
    <StatisticCard
      loading={isLoading}
      title={<TitleWithPercentage title={title} />}
      statistic={{
        description: <Statistic title={t('usage.cards.month.modelCalls')} value={calls} />,
        precision: 2,
        prefix: '$',
        value: spend,
      }}
    />
  );
});

export default MonthSpend;

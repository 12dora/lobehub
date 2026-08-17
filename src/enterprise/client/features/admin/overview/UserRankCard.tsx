'use client';

import { BarList } from '@lobehub/charts';
import { Avatar } from '@lobehub/ui';
import { Segmented } from '@lobehub/ui/base-ui';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_AVATAR } from '@/const/meta';
import type {
  AdminStatsUserRankItem,
  AdminStatsUserRankOrderBy,
} from '@/enterprise/client/services/adminStats';
import { formatPrice, formatUsageValue } from '@/utils/format';

import type { AdminTimeRangeBounds } from '../primitives/timeRange.utils';
import OverviewRankSection from './OverviewRankSection';
import { overviewStyles as styles } from './styles';
import { overviewCardState } from './useOverviewCardState';
import { useOverviewUserRank } from './useOverviewStats';

/** Which figure the bars are ranked by. The server orders and truncates by it. */
type UserRankMetric = AdminStatsUserRankOrderBy;

const METRIC_KEYS: UserRankMetric[] = ['totalTokens', 'messages', 'cost'];

const METRIC_LABEL_KEY = {
  cost: 'overview.rank.usersMetricCost',
  messages: 'overview.rank.usersMetricMessages',
  totalTokens: 'overview.rank.usersMetricTokens',
} as const satisfies Record<UserRankMetric, string>;

const metricValue = (item: AdminStatsUserRankItem, metric: UserRankMetric): number => item[metric];

const formatMetric = (value: number, metric: UserRankMetric): string =>
  metric === 'cost' ? `$${formatPrice(value, 2)}` : formatUsageValue(value);

interface UserRankCardProps {
  range?: AdminTimeRangeBounds;
}

/**
 * Top users by usage inside the selected window. The metric switch refetches: the top 5
 * by tokens are not the top 5 by messages or cost, so the server has to rank and truncate
 * by the selected metric — re-sorting the loaded five would silently hide the real leaders.
 */
const UserRankCard = memo<UserRankCardProps>(({ range }) => {
  const { t } = useTranslation('admin');
  const [metric, setMetric] = useState<UserRankMetric>('totalTokens');
  const { data, error, isLoading, mutate } = useOverviewUserRank(range, metric);

  const rows = useMemo(() => {
    if (!data?.length) return [];
    // BarList renders one figure per row, so the two metrics that are not being
    // ranked ride along the name as muted secondary text instead of a tooltip.
    const secondary = (item: AdminStatsUserRankItem) =>
      METRIC_KEYS.filter((key) => key !== metric)
        .map((key) => `${t(METRIC_LABEL_KEY[key])} ${formatMetric(metricValue(item, key), key)}`)
        .join(' · ');

    // Server order is authoritative (ORDER BY <metric> DESC, userId ASC) — keep it.
    return data.map((item) => ({
      icon: <Avatar alt={item.name} avatar={item.avatar || DEFAULT_AVATAR} size={20} />,
      key: item.userId,
      name: (
        <span>
          {item.name}
          <span className={styles.rankMeta}>{secondary(item)}</span>
        </span>
      ),
      value: metricValue(item, metric),
    }));
  }, [data, metric, t]);

  const state = overviewCardState({
    data,
    empty: rows.every((row) => !row.value),
    error,
    isLoading,
  });
  const noData = {
    desc: t('overview.rank.usersEmptyDesc'),
    title: t('overview.rank.emptyTitle'),
  };

  return (
    <OverviewRankSection
      empty={noData}
      state={state}
      title={t('overview.rank.usersTitle')}
      headerExtra={
        <Segmented
          size="small"
          value={metric}
          options={METRIC_KEYS.map((key) => ({
            label: t(METRIC_LABEL_KEY[key]),
            value: key,
          }))}
          onChange={(value) => setMetric(value as UserRankMetric)}
        />
      }
      onRetry={() => void mutate()}
    >
      <BarList
        data={rows}
        height={220}
        leftLabel={t('overview.rank.usersLeft')}
        loading={state.loading}
        noDataText={noData}
        rightLabel={t(METRIC_LABEL_KEY[metric])}
        valueFormatter={(value) => formatMetric(Number(value), metric)}
      />
    </OverviewRankSection>
  );
});

UserRankCard.displayName = 'AdminOverviewUserRankCard';

export default UserRankCard;

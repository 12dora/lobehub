import { BarList } from '@lobehub/charts';
import { ActionIcon, Avatar } from '@lobehub/ui';
import { Segmented } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import { MaximizeIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import ImperativeModal from '@/components/ImperativeModal';
import { DEFAULT_AVATAR } from '@/const/meta';
import {
  statsFilterParams,
  type StatsUserRankItem,
  type StatsUserRankOrderBy,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import { formatPrice, formatUsageValue } from '@/utils/format';

import StatsFormGroup from '../components/StatsFormGroup';

/** Which figure the bars are ranked by. The server orders and truncates by it. */
const METRIC_KEYS: StatsUserRankOrderBy[] = ['totalTokens', 'messages', 'cost'];

const METRIC_LABEL_KEY = {
  cost: 'stats.usersRank.metric.cost',
  messages: 'stats.usersRank.metric.messages',
  totalTokens: 'stats.usersRank.metric.tokens',
} as const satisfies Record<StatsUserRankOrderBy, string>;

const formatMetric = (value: number, metric: StatsUserRankOrderBy): string =>
  metric === 'cost' ? `$${formatPrice(value, 2)}` : formatUsageValue(value);

/**
 * Top users by usage — the same card the overview shows, so the two pages agree.
 * Only rendered when the active data source exposes `rankUsers` (admin global stats):
 * personal and workspace scopes have nothing to rank.
 *
 * The metric switch refetches: the top 5 by tokens are not the top 5 by messages or
 * cost, so the server has to rank and truncate by the selected metric — re-sorting the
 * loaded five would silently hide the real leaders. The page-level filter is passed
 * through whole, so a pinned user gets their own row, consistent with the other cards.
 */
export const UsersRank = memo(() => {
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<StatsUserRankOrderBy>('totalTokens');
  const { t } = useTranslation('auth');
  const { rankUsers } = useStatsDataSource();
  const params = statsFilterParams(useStatsFilter());
  const swrKey = useStatsSwrKey([...statsKeys.rankUsers(), metric]);

  const { data, isLoading, error, mutate } = useClientDataSWR(rankUsers ? swrKey : null, async () =>
    rankUsers!(undefined, { ...params, orderBy: metric }),
  );

  const showExtra = Boolean(data && data.length > 5);

  const rows = useMemo(() => {
    // BarList ranks one figure per row, so the two metrics that are not being ranked
    // ride along the name as muted secondary text.
    const secondary = (item: StatsUserRankItem) =>
      METRIC_KEYS.filter((key) => key !== metric)
        .map((key) => `${t(METRIC_LABEL_KEY[key])} ${formatMetric(item[key], key)}`)
        .join(' · ');

    // Server order is authoritative (ORDER BY <metric> DESC, userId ASC) — keep it.
    return (data ?? []).map((item) => ({
      icon: <Avatar alt={item.name} avatar={item.avatar || DEFAULT_AVATAR} size={20} />,
      key: item.userId,
      name: (
        <span>
          {item.name}
          <span style={{ color: cssVar.colorTextTertiary, fontSize: 12, marginInlineStart: 8 }}>
            {secondary(item)}
          </span>
        </span>
      ),
      value: item[metric],
    }));
  }, [data, metric, t]);

  const metricSwitch = (
    <Segmented
      size="small"
      value={metric}
      options={METRIC_KEYS.map((key) => ({
        label: t(METRIC_LABEL_KEY[key]),
        value: key,
      }))}
      onChange={(value) => setMetric(value as StatsUserRankOrderBy)}
    />
  );

  const barList = (height: number, items: typeof rows) => (
    <BarList
      data={items}
      height={height}
      leftLabel={t('stats.usersRank.left')}
      loading={isLoading || !data}
      rightLabel={t(METRIC_LABEL_KEY[metric])}
      valueFormatter={(value) => formatMetric(Number(value), metric)}
      noDataText={{
        desc: t('stats.empty.desc'),
        title: t('stats.empty.title'),
      }}
    />
  );

  return (
    <>
      <StatsFormGroup
        fontSize={16}
        title={t('stats.usersRank.title')}
        extra={
          <>
            {metricSwitch}
            {showExtra ? (
              <ActionIcon icon={MaximizeIcon} size={'small'} onClick={() => setOpen(true)} />
            ) : null}
          </>
        }
      >
        <AsyncBoundary data={data} error={error} errorVariant={'block'} onRetry={() => mutate()}>
          {barList(220, rows.slice(0, 5))}
        </AsyncBoundary>
      </StatsFormGroup>
      {showExtra && (
        <ImperativeModal
          footer={null}
          loading={isLoading || !data}
          open={open}
          title={t('stats.usersRank.title')}
          onCancel={() => setOpen(false)}
        >
          {barList(340, rows)}
        </ImperativeModal>
      )}
    </>
  );
});

export default UsersRank;

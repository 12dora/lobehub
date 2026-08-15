import { BarList } from '@lobehub/charts';
import { ActionIcon, Avatar } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { MaximizeIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import ImperativeModal from '@/components/ImperativeModal';
import { DEFAULT_AVATAR } from '@/const/meta';
import {
  statsFilterParams,
  type StatsUserRankItem,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import { formatIntergerNumber, formatPrice, formatUsageValue } from '@/utils/format';

import StatsFormGroup from '../components/StatsFormGroup';

/**
 * Top users by token usage. Only rendered when the active data source exposes
 * `rankUsers` (admin global stats) — personal and workspace scopes have nothing
 * to rank, so the card never appears there.
 *
 * The page-level filter is passed through whole: with a user pinned the server returns
 * that user's row, which keeps the card consistent with every other figure on the page
 * instead of quietly ranking the whole platform beside them.
 */
export const UsersRank = memo(() => {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('auth');
  const { rankUsers } = useStatsDataSource();
  const params = statsFilterParams(useStatsFilter());
  const swrKey = useStatsSwrKey(statsKeys.rankUsers());

  const { data, isLoading, error, mutate } = useClientDataSWR(rankUsers ? swrKey : null, async () =>
    rankUsers!(undefined, params),
  );

  const showExtra = Boolean(data && data.length > 5);

  const mapData = (item: StatsUserRankItem) => ({
    icon: <Avatar alt={item.name} avatar={item.avatar || DEFAULT_AVATAR} size={20} />,
    key: item.userId,
    // The bar ranks tokens only; messages and cost ride along as muted secondary text.
    name: (
      <span>
        {item.name}
        <span style={{ color: cssVar.colorTextTertiary, fontSize: 12, marginInlineStart: 8 }}>
          {t('stats.usersRank.detail', {
            cost: `$${formatPrice(item.cost, 2)}`,
            messages: formatIntergerNumber(item.messages),
          })}
        </span>
      </span>
    ),
    value: item.totalTokens,
  });

  return (
    <>
      <StatsFormGroup
        fontSize={16}
        title={t('stats.usersRank.title')}
        extra={
          showExtra ? (
            <ActionIcon icon={MaximizeIcon} size={'small'} onClick={() => setOpen(true)} />
          ) : undefined
        }
      >
        <AsyncBoundary data={data} error={error} errorVariant={'block'} onRetry={() => mutate()}>
          <BarList
            data={data?.slice(0, 5).map((item) => mapData(item)) || []}
            height={220}
            leftLabel={t('stats.usersRank.left')}
            loading={isLoading || !data}
            rightLabel={t('stats.usersRank.right')}
            valueFormatter={(value) => formatUsageValue(Number(value))}
            noDataText={{
              desc: t('stats.empty.desc'),
              title: t('stats.empty.title'),
            }}
          />
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
          <BarList
            data={data?.map((item) => mapData(item)) || []}
            height={340}
            leftLabel={t('stats.usersRank.left')}
            loading={isLoading || !data}
            rightLabel={t('stats.usersRank.right')}
            valueFormatter={(value) => formatUsageValue(Number(value))}
          />
        </ImperativeModal>
      )}
    </>
  );
});

export default UsersRank;

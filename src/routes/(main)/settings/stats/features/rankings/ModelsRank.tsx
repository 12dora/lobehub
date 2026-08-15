import { type ModelRankItem } from '@lobechat/types';
import { BarList } from '@lobehub/charts';
import { ModelIcon } from '@lobehub/icons';
import { ActionIcon } from '@lobehub/ui';
import { MaximizeIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import ImperativeModal from '@/components/ImperativeModal';
import {
  statsFilterParams,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import { getModelDisplayName } from '@/utils/modelLabels';

import StatsFormGroup from '../components/StatsFormGroup';

export const TopicsRank = memo(() => {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('auth');
  const { rankModels } = useStatsDataSource();
  const params = statsFilterParams(useStatsFilter());
  const swrKey = useStatsSwrKey(statsKeys.rankModels());
  const { data, isLoading, error, mutate } = useClientDataSWR(swrKey, async () =>
    rankModels(params),
  );

  const showExtra = Boolean(data && data?.length > 5);

  const mapData = (item: ModelRankItem) => {
    return {
      icon: <ModelIcon model={item.id as string} size={20} />,
      id: item.id,

      name: getModelDisplayName(item.id as string),
      value: item.count,
    };
  };

  return (
    <>
      <StatsFormGroup
        fontSize={16}
        title={t('stats.modelsRank.title')}
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
            leftLabel={t('stats.modelsRank.left')}
            loading={isLoading || !data}
            rightLabel={t('stats.modelsRank.right')}
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
          title={t('stats.modelsRank.title')}
          onCancel={() => setOpen(false)}
        >
          <BarList
            data={data?.map((item) => mapData(item)) || []}
            height={340}
            leftLabel={t('stats.modelsRank.left')}
            loading={isLoading || !data}
            rightLabel={t('stats.modelsRank.right')}
          />
        </ImperativeModal>
      )}
    </>
  );
});

export default TopicsRank;

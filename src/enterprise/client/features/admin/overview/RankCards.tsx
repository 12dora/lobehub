'use client';

import type { ModelRankItem } from '@lobechat/types';
import { BarList } from '@lobehub/charts';
import { ModelIcon } from '@lobehub/icons';
import { Avatar } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_AVATAR } from '@/const/meta';
import type { AgentRankItem } from '@/types/agent';
import { getModelDisplayName } from '@/utils/modelLabels';

import type { AdminTimeRangeBounds } from '../primitives/timeRange.utils';
import OverviewRankSection from './OverviewRankSection';
import { overviewStyles as styles } from './styles';
import { overviewCardState } from './useOverviewCardState';
import { useOverviewAgentRank, useOverviewModelRank } from './useOverviewStats';
import UserRankCard from './UserRankCard';
import { isEmptyRank } from './utils';

// The rank is keyed by the raw model id — icons still match on it, only the label is humanized.
const mapModel = (item: ModelRankItem) => ({
  icon: <ModelIcon model={item.id as string} size={20} />,
  id: item.id,
  name: getModelDisplayName(item.id as string),
  value: item.count,
});

const mapAgent = (item: AgentRankItem, fallbackName: string) => ({
  icon: (
    <Avatar
      alt={item.title || fallbackName}
      avatar={item.avatar || DEFAULT_AVATAR}
      background={item.backgroundColor || undefined}
      size={20}
    />
  ),
  id: item.id,
  name: item.title || fallbackName,
  value: item.count,
});

interface RankCardsProps {
  range?: AdminTimeRangeBounds;
}

const RankCards = memo<RankCardsProps>(({ range }) => {
  const { t } = useTranslation('admin');
  const models = useOverviewModelRank(range);
  const agents = useOverviewAgentRank(range);
  const modelsState = overviewCardState({
    data: models.data,
    empty: isEmptyRank(models.data),
    error: models.error,
    isLoading: models.isLoading,
  });
  const agentsState = overviewCardState({
    data: agents.data,
    empty: isEmptyRank(agents.data),
    error: agents.error,
    isLoading: agents.isLoading,
  });
  const fallbackAgent = t('overview.rank.agentFallback');

  const noData = {
    desc: t('overview.rank.emptyDesc'),
    title: t('overview.rank.emptyTitle'),
  };

  return (
    <div className={styles.rankGrid}>
      <OverviewRankSection
        empty={noData}
        state={modelsState}
        title={t('overview.rank.modelsTitle')}
        onRetry={() => void models.mutate()}
      >
        <BarList
          data={(models.data ?? []).map(mapModel)}
          height={220}
          leftLabel={t('overview.rank.modelsLeft')}
          loading={modelsState.loading}
          noDataText={noData}
          rightLabel={t('overview.rank.modelsRight')}
        />
      </OverviewRankSection>

      <OverviewRankSection
        empty={noData}
        state={agentsState}
        title={t('overview.rank.agentsTitle')}
        onRetry={() => void agents.mutate()}
      >
        <BarList
          data={(agents.data ?? []).map((item) => mapAgent(item, fallbackAgent))}
          height={220}
          leftLabel={t('overview.rank.agentsLeft')}
          loading={agentsState.loading}
          noDataText={noData}
          rightLabel={t('overview.rank.agentsRight')}
        />
      </OverviewRankSection>

      <UserRankCard range={range} />
    </div>
  );
});

RankCards.displayName = 'AdminOverviewRankCards';

export default RankCards;

'use client';

import type { ModelRankItem } from '@lobechat/types';
import { BarList } from '@lobehub/charts';
import { ModelIcon } from '@lobehub/icons';
import { Alert, Avatar } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_AVATAR } from '@/const/meta';
import type { AgentRankItem } from '@/types/agent';
import { getModelDisplayName } from '@/utils/modelLabels';

import type { AdminTimeRangeBounds } from '../primitives/timeRange.utils';
import OverviewCardState from './OverviewCardState';
import { overviewStyles as styles } from './styles';
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

  const modelsLoading = models.isLoading && !models.data;
  const agentsLoading = agents.isLoading && !agents.data;
  const modelsFirstError = Boolean(models.error && !models.data);
  const agentsFirstError = Boolean(agents.error && !agents.data);
  const modelsStaleError = Boolean(models.error && models.data);
  const agentsStaleError = Boolean(agents.error && agents.data);
  const modelsEmpty = !modelsLoading && !modelsFirstError && isEmptyRank(models.data);
  const agentsEmpty = !agentsLoading && !agentsFirstError && isEmptyRank(agents.data);
  const fallbackAgent = t('overview.rank.agentFallback');

  const noData = {
    desc: t('overview.rank.emptyDesc'),
    title: t('overview.rank.emptyTitle'),
  };

  const firstLoadError = (retry: () => void) => (
    <Alert
      showIcon
      description={t('overview.error.loadFailedDescription')}
      message={t('overview.error.loadFailed')}
      type="error"
      action={
        <Button size="small" onClick={retry}>
          {t('overview.error.retry')}
        </Button>
      }
    />
  );

  const refreshWarning = (retry: () => void) => (
    <Alert
      showIcon
      description={t('overview.error.refreshFailedDescription')}
      message={t('overview.error.refreshFailed')}
      type="warning"
      action={
        <Button size="small" onClick={retry}>
          {t('overview.error.retry')}
        </Button>
      }
    />
  );

  return (
    <div className={styles.rankGrid}>
      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>{t('overview.rank.modelsTitle')}</h2>
        {modelsStaleError ? refreshWarning(() => void models.mutate()) : null}
        <OverviewCardState
          stateKey={
            modelsLoading ? 'loading' : modelsFirstError ? 'error' : modelsEmpty ? 'empty' : 'data'
          }
        >
          {modelsFirstError ? (
            firstLoadError(() => void models.mutate())
          ) : modelsEmpty ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{noData.title}</p>
              <p className={styles.emptyDesc}>{noData.desc}</p>
            </div>
          ) : (
            <BarList
              data={(models.data ?? []).map(mapModel)}
              height={220}
              leftLabel={t('overview.rank.modelsLeft')}
              loading={modelsLoading}
              noDataText={noData}
              rightLabel={t('overview.rank.modelsRight')}
            />
          )}
        </OverviewCardState>
      </section>

      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>{t('overview.rank.agentsTitle')}</h2>
        {agentsStaleError ? refreshWarning(() => void agents.mutate()) : null}
        <OverviewCardState
          stateKey={
            agentsLoading ? 'loading' : agentsFirstError ? 'error' : agentsEmpty ? 'empty' : 'data'
          }
        >
          {agentsFirstError ? (
            firstLoadError(() => void agents.mutate())
          ) : agentsEmpty ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{noData.title}</p>
              <p className={styles.emptyDesc}>{noData.desc}</p>
            </div>
          ) : (
            <BarList
              data={(agents.data ?? []).map((item) => mapAgent(item, fallbackAgent))}
              height={220}
              leftLabel={t('overview.rank.agentsLeft')}
              loading={agentsLoading}
              noDataText={noData}
              rightLabel={t('overview.rank.agentsRight')}
            />
          )}
        </OverviewCardState>
      </section>

      <UserRankCard range={range} />
    </div>
  );
});

RankCards.displayName = 'AdminOverviewRankCards';

export default RankCards;

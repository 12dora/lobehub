'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

export interface AgentListLoadMoreProps {
  hasMore: boolean;
  isLoadingMore: boolean;
  /** Zero rows: the empty state already speaks, so this footer says nothing. */
  itemCount: number;
  loadMore: () => void;
  /** A later page failed — surfaced inline, without discarding the rows already on screen. */
  loadMoreError: boolean;
  retry: () => void;
}

/** The end of the cursor-paginated list: retry, load more, or "that was everything". */
export const AgentListLoadMore = memo<AgentListLoadMoreProps>(
  ({ hasMore, isLoadingMore, itemCount, loadMore, loadMoreError, retry }) => {
    const { t } = useTranslation('admin');
    return (
      <Flexbox horizontal align="center" gap={8} justify="center">
        {loadMoreError ? (
          <Flexbox horizontal align="center" gap={8}>
            <Text type="danger">{t('agentCatalog.list.loadMoreError')}</Text>
            <Button onClick={retry}>{t('agentCatalog.dependency.retry')}</Button>
          </Flexbox>
        ) : hasMore ? (
          <Button loading={isLoadingMore} onClick={loadMore}>
            {isLoadingMore ? t('agentCatalog.list.loadingMore') : t('agentCatalog.list.loadMore')}
          </Button>
        ) : itemCount > 0 ? (
          <Text type="secondary">{t('agentCatalog.list.end')}</Text>
        ) : null}
      </Flexbox>
    );
  },
);

AgentListLoadMore.displayName = 'AgentListLoadMore';

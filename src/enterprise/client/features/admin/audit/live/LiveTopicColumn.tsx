'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import LiveGapBanner from './LiveGapBanner';
import { styles } from './liveStyles';
import TopicListPane from './TopicListPane';
import type { LiveAuditFeeds } from './useLiveAuditFeeds';

export interface LiveTopicColumnProps {
  feed: LiveAuditFeeds['topics'];
  onSelect: (topicId: string) => void;
  selectedTopicId: string | undefined;
}

/** Left column of the live layout: the topic list plus its own page-load failure strip. */
const LiveTopicColumn = memo<LiveTopicColumnProps>(({ feed, onSelect, selectedTopicId }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.left}>
      <TopicListPane
        hasMore={feed.hasMore}
        items={feed.items}
        loading={feed.loading}
        selectedTopicId={selectedTopicId}
        onLoadMore={feed.loadMore}
        onSelect={onSelect}
      />
      {feed.pageError ? (
        <LiveGapBanner
          actionLabel={t('audit.live.errors.retry', { defaultValue: 'Retry' })}
          message={feed.pageError}
          role="alert"
          onAction={feed.loadMore}
        />
      ) : null}
    </div>
  );
});

LiveTopicColumn.displayName = 'AuditLiveTopicColumn';

export default LiveTopicColumn;

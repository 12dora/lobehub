'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import LiveGapBanner from './LiveGapBanner';
import { styles } from './liveStyles';
import MessagePane from './MessagePane';
import type { LiveAuditFeeds } from './useLiveAuditFeeds';

export interface LiveMessageColumnProps {
  bodyHidden: boolean;
  feed: LiveAuditFeeds['messages'];
  userId: string;
}

/** Right column of the live layout: page-load failure, gap warning, then the message stream. */
const LiveMessageColumn = memo<LiveMessageColumnProps>(({ bodyHidden, feed, userId }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.right}>
      {feed.pageError ? (
        <LiveGapBanner
          actionLabel={t('audit.live.errors.retry', { defaultValue: 'Retry' })}
          message={feed.pageError}
          role="alert"
          onAction={feed.loadOlder}
        />
      ) : null}
      {feed.gap ? (
        <LiveGapBanner
          actionLabel={t('audit.live.messages.reload')}
          message={t('audit.live.messages.gapWarning')}
          role="status"
          onAction={feed.reload}
        />
      ) : null}
      <MessagePane
        bodyHidden={bodyHidden}
        hasOlder={feed.hasOlder}
        loading={feed.loading}
        loadingOlder={feed.loadingOlder}
        messages={feed.items}
        topic={feed.topic}
        userId={userId}
        onLoadOlder={feed.loadOlder}
      />
    </div>
  );
});

LiveMessageColumn.displayName = 'AuditLiveMessageColumn';

export default LiveMessageColumn;

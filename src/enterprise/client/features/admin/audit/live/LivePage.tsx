'use client';

import { Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import ContentAccessDisabledState from '../conversations/ContentAccessDisabledState';
import { hasPermission } from '../shared/format';
import LiveGapBanner from './LiveGapBanner';
import LiveMessageColumn from './LiveMessageColumn';
import { styles } from './liveStyles';
import LiveToolbar from './LiveToolbar';
import LiveTopicColumn from './LiveTopicColumn';
import { useLiveAuditFeeds } from './useLiveAuditFeeds';
import { useLiveFilters } from './useLiveFilters';

const LivePage = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const canConversationRead = hasPermission(
    permissions,
    PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ,
  );
  const canAuditRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  const { live, onUserChange, pageVisible, poll, setLive, setTopicId, topicId, userId } =
    useLiveFilters(canConversationRead);

  const { access, messages, refresh, topics } = useLiveAuditFeeds({
    canAuditRead,
    canConversationRead,
    poll,
    t,
    topicId,
    userId,
  });

  if (access.isForbidden || access.contentAccessMode === 'disabled') {
    return <ContentAccessDisabledState />;
  }

  if (access.messagesAccessDenied && !canAuditRead) {
    // No conversation read and no audit read — nothing useful to show.
    return <ContentAccessDisabledState />;
  }

  return (
    <AdminPageTemplate
      title={t('audit.live.page.title')}
      banner={
        access.showPolicyBanner && access.contentAccessMode === 'content_allowed' ? (
          <div className={styles.banner} role="status">
            {t('audit.live.banner.contentAllowed')}
          </div>
        ) : null
      }
      description={
        <span>
          {t('audit.live.page.desc')}
          {access.showPolicyBanner && access.contentAccessMode === 'metadata_only' ? (
            <span role="status"> {t('audit.live.banner.metadataOnly')}</span>
          ) : null}
        </span>
      }
      toolbar={
        <LiveToolbar
          canAuditRead={canAuditRead}
          lastRefreshedAt={refresh.lastRefreshedAt}
          live={live}
          pageVisible={pageVisible}
          setLive={setLive}
          userId={userId}
          onRefreshNow={() => void refresh.refreshAllFeeds()}
          onUserChange={onUserChange}
        />
      }
    >
      {access.feedError ? (
        <LiveGapBanner
          actionLabel={t('audit.live.errors.retry', { defaultValue: 'Retry' })}
          message={access.feedError}
          role="alert"
          onAction={() => void refresh.refreshAllFeeds()}
        />
      ) : null}
      {access.messagesAccessDenied ? (
        <div className={styles.emptyGuide} role="status">
          <Text type="secondary">{t('audit.live.empty.noConversationPermission')}</Text>
        </div>
      ) : !userId ? (
        <div className={styles.emptyGuide}>
          <Text type="secondary">{t('audit.live.empty.pickUser')}</Text>
        </div>
      ) : (
        <div className={styles.layout}>
          <LiveTopicColumn feed={topics} selectedTopicId={topicId} onSelect={setTopicId} />
          <LiveMessageColumn bodyHidden={access.bodyHidden} feed={messages} userId={userId} />
        </div>
      )}
    </AdminPageTemplate>
  );
});

LivePage.displayName = 'AuditLivePage';

export default LivePage;

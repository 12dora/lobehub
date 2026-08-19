'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useIsPollGateOpen } from '@/enterprise/client/shared/useVisiblePoll';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import ContentAccessDisabledState from '../conversations/ContentAccessDisabledState';
import {
  useFetchAuditConversation,
  useFetchAuditConversationMessages,
  useFetchAuditPolicy,
} from '../hooks/useAdminAudit';
import AuditUserSearchSelect from '../shared/AuditUserSearchSelect';
import { formatAdminDateTime, hasPermission } from '../shared/format';
import { AUDIT_LIST_POLL_MS } from '../shared/useCursorPagination';
import MessagePane from './MessagePane';
import TopicListPane from './TopicListPane';
import { useLiveAuditAccess } from './useLiveAuditAccess';
import { useLiveFeedRefresh } from './useLiveFeedRefresh';
import { MSG_LIMIT, useLiveMessageFeed } from './useLiveMessageFeed';
import { useLiveTopicPagination } from './useLiveTopicPagination';

const styles = createStaticStyles(({ css }) => ({
  layout: css`
    overflow: hidden;
    display: flex;
    flex: 1;

    height: calc(100vh - 220px);
    min-height: 480px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  left: css`
    flex: 0 0 320px;

    width: 320px;
    min-width: 260px;
    max-width: 360px;
    min-height: 0;
  `,
  right: css`
    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    min-height: 0;
  `,
  toolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  `,
  liveDot: css`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${cssVar.colorSuccess};

    @keyframes audit-live-pulse {
      0% {
        opacity: 1;
        box-shadow: 0 0 0 0 ${cssVar.colorSuccess};
      }

      70% {
        opacity: 0.7;
        box-shadow: 0 0 0 6px transparent;
      }

      100% {
        opacity: 1;
        box-shadow: 0 0 0 0 transparent;
      }
    }

    &[data-on='true'] {
      animation: audit-live-pulse 1.6s ease-out infinite;
    }

    &[data-on='false'] {
      background: ${cssVar.colorTextQuaternary};
    }
  `,
  banner: css`
    padding-block: 8px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorWarningBorder};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorWarningBg};
  `,
  gapBanner: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    padding-block: 8px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorWarningBorder};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorWarningBg};
  `,
  emptyGuide: css`
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;

    padding: 48px;
  `,
}));

const LivePage = memo(() => {
  const { t } = useTranslation('admin');
  const [searchParams] = useSearchParams();
  const { permissions } = useAdminAccess();
  const canConversationRead = hasPermission(
    permissions,
    PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ,
  );
  const canAuditRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  const [userId, setUserId] = useState<string | undefined>(
    () => searchParams.get('userId') || undefined,
  );
  const [topicId, setTopicId] = useState<string | undefined>(
    () => searchParams.get('topicId') || undefined,
  );
  const [live, setLive] = useState(true);
  // Shared with every other admin poll (visible + online), so the live dot and the 4s poll stop
  // together the moment this tab goes to the background.
  const pageVisible = useIsPollGateOpen();

  const poll = live && pageVisible && canConversationRead;

  // Prefill from query when URL changes (e.g. evidence → live deep link).
  // Always sync both params so removing userId/topicId clears stale state.
  useEffect(() => {
    const qUser = searchParams.get('userId') || undefined;
    const qTopic = searchParams.get('topicId') || undefined;
    setUserId(qUser);
    setTopicId(qUser ? qTopic : undefined);
  }, [searchParams]);

  const onUserChange = useCallback((id: string | undefined) => {
    setUserId(id);
    setTopicId(undefined);
  }, []);

  const {
    loadMoreTopics,
    loadingMoreTopics,
    orderedTopics,
    topicNextCursor,
    topicPageError,
    topics,
  } = useLiveTopicPagination({ canConversationRead, poll, t, userId });

  // policy.get requires AUDIT_READ — do not gate on conversation-only permission.
  const policy = useFetchAuditPolicy(canAuditRead);

  const topicDetail = useFetchAuditConversation(
    userId,
    topicId,
    canConversationRead && !!userId && !!topicId,
  );

  // Request bodies when conversation read is allowed; server + polled contentAccessMode
  // are authoritative if policy was revoked to metadata_only mid-session.
  const messagesLive = useFetchAuditConversationMessages(
    {
      includeBody: canConversationRead,
      limit: MSG_LIMIT,
      topicId: topicId!,
      userId: userId!,
    },
    canConversationRead && !!userId && !!topicId,
    { refreshInterval: poll && !!topicId ? AUDIT_LIST_POLL_MS : 0 },
  );

  const {
    accessEpochRef,
    bodyHidden,
    contentAccessMode,
    feedError,
    includeBody,
    isForbidden,
    liveAccess,
    messagesAccessDenied,
    showPolicyBanner,
  } = useLiveAuditAccess({
    canAuditRead,
    canConversationRead,
    messagesLive,
    policy,
    t,
    topicDetail,
    topicId,
    topics,
    userId,
  });

  const {
    allMessages,
    loadOlderMessages,
    loadingOlder,
    messageGap,
    messagePageError,
    olderNextCursor,
    reloadMessages,
  } = useLiveMessageFeed({
    accessEpochRef,
    bodyHidden,
    canConversationRead,
    contentAccessMode,
    includeBody,
    messagesAccessDenied,
    messagesLive,
    mustPurgeCachedBodies: liveAccess.mustPurgeCachedBodies,
    t,
    topicId,
    userId,
  });

  const { lastRefreshedAt, refreshAllFeeds } = useLiveFeedRefresh({
    messagesLive,
    topicDetail,
    topicId,
    topics,
    userId,
  });

  if (isForbidden || contentAccessMode === 'disabled') {
    return <ContentAccessDisabledState />;
  }

  if (messagesAccessDenied && !canAuditRead) {
    // No conversation read and no audit read — nothing useful to show.
    return <ContentAccessDisabledState />;
  }

  return (
    <AdminPageTemplate
      description={t('audit.live.page.desc')}
      title={t('audit.live.page.title')}
      banner={
        showPolicyBanner && contentAccessMode === 'content_allowed' ? (
          <div className={styles.banner} role="status">
            {t('audit.live.banner.contentAllowed')}
          </div>
        ) : null
      }
      notice={
        showPolicyBanner && contentAccessMode === 'metadata_only' ? (
          <Text role="status" type="warning">
            {t('audit.live.banner.metadataOnly')}
          </Text>
        ) : null
      }
      toolbar={
        <div className={styles.toolbar}>
          <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
            <AuditUserSearchSelect
              enabled={canAuditRead}
              placeholder={t('audit.live.filters.user')}
              style={{ width: '100%' }}
              value={userId}
              onChange={onUserChange}
            />
          </div>
          <Flexbox horizontal align="center" gap={8}>
            <span className={styles.liveDot} data-on={live && pageVisible} />
            <Text type="secondary">{t('audit.live.filters.live')}</Text>
            <Switch checked={live} onChange={(v) => setLive(Boolean(v))} />
            {lastRefreshedAt ? (
              <Text style={{ fontSize: 12 }} type="secondary">
                {t('audit.live.filters.refreshed', {
                  time: formatAdminDateTime(lastRefreshedAt),
                })}
              </Text>
            ) : null}
          </Flexbox>
          {live ? null : (
            <Button size="small" type="default" onClick={() => void refreshAllFeeds()}>
              {t('audit.live.filters.refreshNow')}
            </Button>
          )}
        </div>
      }
    >
      {feedError ? (
        <div className={styles.gapBanner} role="alert">
          <Text>{feedError}</Text>
          <Button size="small" type="primary" onClick={() => void refreshAllFeeds()}>
            {t('audit.live.errors.retry', { defaultValue: 'Retry' })}
          </Button>
        </div>
      ) : null}
      {messagesAccessDenied ? (
        <div className={styles.emptyGuide} role="status">
          <Text type="secondary">{t('audit.live.empty.noConversationPermission')}</Text>
        </div>
      ) : !userId ? (
        <div className={styles.emptyGuide}>
          <Text type="secondary">{t('audit.live.empty.pickUser')}</Text>
        </div>
      ) : (
        <div className={styles.layout}>
          <div className={styles.left}>
            <TopicListPane
              hasMore={Boolean(topicNextCursor)}
              items={orderedTopics}
              loading={(topics.isLoading && !topics.data) || loadingMoreTopics}
              selectedTopicId={topicId}
              onLoadMore={() => void loadMoreTopics()}
              onSelect={setTopicId}
            />
            {topicPageError ? (
              <div className={styles.gapBanner} role="alert">
                <Text>{topicPageError}</Text>
                <Button size="small" type="primary" onClick={() => void loadMoreTopics()}>
                  {t('audit.live.errors.retry', { defaultValue: 'Retry' })}
                </Button>
              </div>
            ) : null}
          </div>
          <div className={styles.right}>
            {messagePageError ? (
              <div className={styles.gapBanner} role="alert">
                <Text>{messagePageError}</Text>
                <Button size="small" type="primary" onClick={() => void loadOlderMessages()}>
                  {t('audit.live.errors.retry', { defaultValue: 'Retry' })}
                </Button>
              </div>
            ) : null}
            {messageGap ? (
              <div className={styles.gapBanner} role="status">
                <Text>{t('audit.live.messages.gapWarning')}</Text>
                <Button size="small" type="primary" onClick={reloadMessages}>
                  {t('audit.live.messages.reload')}
                </Button>
              </div>
            ) : null}
            <MessagePane
              bodyHidden={bodyHidden}
              hasOlder={Boolean(olderNextCursor) && canConversationRead}
              loading={messagesLive.isLoading && !messagesLive.data}
              loadingOlder={loadingOlder}
              messages={allMessages}
              topic={topicDetail.data}
              userId={userId}
              onLoadOlder={() => void loadOlderMessages()}
            />
          </div>
        </div>
      )}
    </AdminPageTemplate>
  );
});

LivePage.displayName = 'AuditLivePage';

export default LivePage;

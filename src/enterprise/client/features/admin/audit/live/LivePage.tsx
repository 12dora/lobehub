'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditConversationMessage } from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import ContentAccessDisabledState from '../conversations/ContentAccessDisabledState';
import {
  useFetchAuditConversation,
  useFetchAuditConversationMessages,
  useFetchAuditConversationsList,
  useFetchAuditPolicy,
} from '../hooks/useAdminAudit';
import AuditUserSearchSelect from '../shared/AuditUserSearchSelect';
import { formatAdminDateTime, hasPermission } from '../shared/format';
import { mergeMessagePages } from '../shared/liveMessageUtils';
import MessagePane from './MessagePane';
import TopicListPane from './TopicListPane';

const POLL_MS = 4000;
const LIST_LIMIT = 30;
const MSG_LIMIT = 100;

const styles = createStaticStyles(({ css }) => ({
  layout: css`
    overflow: hidden;
    display: flex;
    flex: 1;

    height: calc(100vh - 220px);
    min-height: 0;
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
  const { permissions } = useAdminAccess();
  const canRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ);

  const [userId, setUserId] = useState<string | undefined>();
  const [topicId, setTopicId] = useState<string | undefined>();
  const [live, setLive] = useState(true);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  const [listCursorStack, setListCursorStack] = useState<(string | null)[]>([]);
  const [olderPages, setOlderPages] = useState<AdminAuditConversationMessage[][]>([]);
  const [olderNextCursor, setOlderNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const listCursor = listCursorStack.at(-1) ?? null;
  const poll = live && pageVisible && canRead;

  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    setTopicId(undefined);
    setListCursorStack([]);
    setOlderPages([]);
    setOlderNextCursor(null);
  }, [userId]);

  useEffect(() => {
    setOlderPages([]);
    setOlderNextCursor(null);
  }, [topicId]);

  const policy = useFetchAuditPolicy(canRead);
  const contentAccessMode = policy.data?.contentAccessMode;
  const includeBody = contentAccessMode === 'content_allowed';
  const bodyHidden = contentAccessMode === 'metadata_only';

  const topics = useFetchAuditConversationsList(
    {
      cursor: listCursor,
      limit: LIST_LIMIT,
      userId: userId!,
    },
    canRead && !!userId,
    { refreshInterval: poll && !!userId ? POLL_MS : 0 },
  );

  const topicDetail = useFetchAuditConversation(userId, topicId, canRead && !!userId && !!topicId);

  const messagesLive = useFetchAuditConversationMessages(
    {
      includeBody,
      limit: MSG_LIMIT,
      topicId: topicId!,
      userId: userId!,
    },
    canRead && !!userId && !!topicId,
    { refreshInterval: poll && !!topicId ? POLL_MS : 0 },
  );

  useEffect(() => {
    if (topics.data || messagesLive.data) {
      setLastRefreshedAt(new Date());
    }
  }, [topics.data, messagesLive.data]);

  const isForbidden = useMemo(() => {
    const errors = [topics.error, messagesLive.error, topicDetail.error, policy.error];
    return errors.some((err) => {
      if (!err) return false;
      return (err as { data?: { code?: string } }).data?.code === 'FORBIDDEN';
    });
  }, [messagesLive.error, policy.error, topicDetail.error, topics.error]);

  // First older page continues from the live head page's nextCursor; further pages use olderNextCursor.
  useEffect(() => {
    if (olderPages.length === 0) {
      setOlderNextCursor(messagesLive.data?.nextCursor ?? null);
    }
  }, [messagesLive.data?.nextCursor, olderPages.length]);

  const loadOlder = useCallback(async () => {
    const next = olderNextCursor;
    if (!next || !userId || !topicId || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const { adminAuditService } = await import('@/enterprise/client/services/adminAudit');
      const page = await adminAuditService.listConversationMessages({
        cursor: next,
        includeBody,
        limit: MSG_LIMIT,
        topicId,
        userId,
      });
      setOlderPages((p) => [...p, page.items]);
      setOlderNextCursor(page.nextCursor);
    } finally {
      setLoadingOlder(false);
    }
  }, [includeBody, loadingOlder, olderNextCursor, topicId, userId]);

  const allMessages = useMemo(() => {
    const latest = messagesLive.data?.items ?? [];
    return mergeMessagePages(olderPages.flat(), latest);
  }, [messagesLive.data?.items, olderPages]);

  const topicItems = topics.data?.items ?? [];
  // Prefer freshest topics first (API typically returns updatedAt desc already).
  const orderedTopics = useMemo(
    () =>
      [...topicItems].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [topicItems],
  );

  if (isForbidden || contentAccessMode === 'disabled') {
    return <ContentAccessDisabledState />;
  }

  return (
    <AdminPageTemplate
      description={t('audit.live.page.desc')}
      title={t('audit.live.page.title')}
      banner={
        contentAccessMode === 'content_allowed' ? (
          <div className={styles.banner} role="status">
            {t('audit.live.banner.contentAllowed')}
          </div>
        ) : contentAccessMode === 'metadata_only' ? (
          <div className={styles.banner} role="status">
            {t('audit.live.banner.metadataOnly')}
          </div>
        ) : null
      }
      toolbar={
        <div className={styles.toolbar}>
          <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
            <AuditUserSearchSelect
              enabled={canRead}
              placeholder={t('audit.live.filters.user')}
              style={{ width: '100%' }}
              value={userId}
              onChange={(id) => setUserId(id)}
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
            <Button
              size="small"
              type="default"
              onClick={() => {
                void topics.mutate();
                void messagesLive.mutate();
                setLastRefreshedAt(new Date());
              }}
            >
              {t('audit.live.filters.refreshNow')}
            </Button>
          )}
        </div>
      }
    >
      {!userId ? (
        <div className={styles.emptyGuide}>
          <Text type="secondary">{t('audit.live.empty.pickUser')}</Text>
        </div>
      ) : (
        <div className={styles.layout}>
          <div className={styles.left}>
            <TopicListPane
              hasMore={Boolean(topics.data?.nextCursor)}
              items={orderedTopics}
              loading={topics.isLoading && !topics.data}
              selectedTopicId={topicId}
              onSelect={setTopicId}
              onLoadMore={() => {
                const next = topics.data?.nextCursor;
                if (next) setListCursorStack((s) => [...s, next]);
              }}
            />
          </div>
          <div className={styles.right}>
            <MessagePane
              bodyHidden={bodyHidden}
              hasOlder={Boolean(olderNextCursor)}
              loading={messagesLive.isLoading && !messagesLive.data}
              loadingOlder={loadingOlder}
              messages={allMessages}
              topic={topicDetail.data}
              userId={userId}
              onLoadOlder={() => void loadOlder()}
            />
          </div>
        </div>
      )}
    </AdminPageTemplate>
  );
});

LivePage.displayName = 'AuditLivePage';

export default LivePage;

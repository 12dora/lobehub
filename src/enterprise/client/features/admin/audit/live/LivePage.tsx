'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type {
  AdminAuditConversationListItem,
  AdminAuditConversationMessage,
} from '@/enterprise/client/services/adminAudit';
import { adminAuditService } from '@/enterprise/client/services/adminAudit';

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
import {
  type AuditContentAccessMode,
  mergeMessagePages,
  resolveLiveBodyAccess,
  stripMessageBodies,
} from '../shared/liveMessageUtils';
import { idSetsDisjoint, mergeTopicPages } from '../shared/topicListUtils';
import { AUDIT_LIST_POLL_MS } from '../shared/useCursorPagination';
import MessagePane from './MessagePane';
import TopicListPane from './TopicListPane';

const LIST_LIMIT = 30;
const MSG_LIMIT = 100;

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

const isForbiddenError = (err: unknown) =>
  Boolean(err && (err as { data?: { code?: string } }).data?.code === 'FORBIDDEN');

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
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );

  // Topics: always poll head (no cursor); accumulate older pages for "load more".
  const [topicOlderPages, setTopicOlderPages] = useState<AdminAuditConversationListItem[][]>([]);
  const [topicNextCursor, setTopicNextCursor] = useState<string | null>(null);
  const [loadingMoreTopics, setLoadingMoreTopics] = useState(false);

  // Messages: poll head; accumulate older pages.
  const [olderPages, setOlderPages] = useState<AdminAuditConversationMessage[][]>([]);
  const [olderNextCursor, setOlderNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messageGap, setMessageGap] = useState(false);
  const prevHeadIdsRef = useRef<Set<string>>(new Set());

  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [topicPageError, setTopicPageError] = useState<string | null>(null);
  const [messagePageError, setMessagePageError] = useState<string | null>(null);
  const topicsValidatingRef = useRef(false);
  const messagesValidatingRef = useRef(false);

  const poll = live && pageVisible && canConversationRead;

  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Prefill from query when URL changes (e.g. evidence → live deep link).
  useEffect(() => {
    const qUser = searchParams.get('userId') || undefined;
    const qTopic = searchParams.get('topicId') || undefined;
    if (qUser) {
      setUserId(qUser);
      if (qTopic) setTopicId(qTopic);
    }
  }, [searchParams]);

  const resetTopicPagination = useCallback(() => {
    setTopicOlderPages([]);
    setTopicNextCursor(null);
  }, []);

  const resetMessagePagination = useCallback(() => {
    setOlderPages([]);
    setOlderNextCursor(null);
    setMessageGap(false);
    prevHeadIdsRef.current = new Set();
  }, []);

  useEffect(() => {
    resetTopicPagination();
    resetMessagePagination();
  }, [userId, resetMessagePagination, resetTopicPagination]);

  useEffect(() => {
    resetMessagePagination();
  }, [topicId, resetMessagePagination]);

  const onUserChange = useCallback((id: string | undefined) => {
    setUserId(id);
    setTopicId(undefined);
  }, []);

  // policy.get requires AUDIT_READ — do not gate on conversation-only permission.
  // Prefer authoritative contentAccessMode from the polled messages response so a
  // remote policy transition (e.g. content_allowed → metadata_only) is observed
  // even when the non-polling policy hook is stale.
  const policy = useFetchAuditPolicy(canAuditRead);

  const topics = useFetchAuditConversationsList(
    {
      limit: LIST_LIMIT,
      userId: userId!,
    },
    canConversationRead && !!userId,
    { refreshInterval: poll && !!userId ? AUDIT_LIST_POLL_MS : 0 },
  );

  const topicDetail = useFetchAuditConversation(
    userId,
    topicId,
    canConversationRead && !!userId && !!topicId,
  );

  // Sticky polled mode: after SWR head purge we must not fall back to a stale
  // policy.get snapshot and re-enable body serving until the next authorized poll.
  const lastPolledModeRef = useRef<AuditContentAccessMode | undefined>(undefined);

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

  useEffect(() => {
    const polled = messagesLive.data?.contentAccessMode as AuditContentAccessMode | undefined;
    if (polled) lastPolledModeRef.current = polled;
  }, [messagesLive.data?.contentAccessMode]);

  // Reset sticky mode when the operator switches topic/user so we re-resolve fresh.
  useEffect(() => {
    lastPolledModeRef.current = undefined;
  }, [userId, topicId]);

  const contentAccessMode =
    (messagesLive.data?.contentAccessMode as AuditContentAccessMode | undefined) ??
    lastPolledModeRef.current ??
    (topicDetail.data?.contentAccessMode as AuditContentAccessMode | undefined) ??
    (policy.data?.contentAccessMode as AuditContentAccessMode | undefined);

  // Re-check authorization on every render/poll: permission + contentAccessMode.
  const liveAccess = resolveLiveBodyAccess({
    canConversationRead,
    contentAccessMode,
  });
  const { bodyHidden, includeBody } = liveAccess;
  const messagesAccessDenied = !canConversationRead;

  // Request epoch: discard in-flight pagination that started under a prior access mode.
  const accessEpochRef = useRef(0);
  useEffect(() => {
    accessEpochRef.current += 1;
  }, [canConversationRead, contentAccessMode, includeBody]);

  // Drop cached body-bearing pages + SWR head when policy or conversation
  // permission is lost so previously loaded content cannot outlive authorization.
  useEffect(() => {
    if (liveAccess.mustPurgeCachedBodies || !includeBody) {
      resetMessagePagination();
    }
    if (liveAccess.mustPurgeCachedBodies) {
      // Clear SWR head so revoked permission/policy cannot keep serving prior bodies.
      void messagesLive.mutate(undefined, { revalidate: false });
    }
    // messagesLive.mutate identity is stable enough for access-edge effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on access edges
  }, [
    canConversationRead,
    contentAccessMode,
    includeBody,
    liveAccess.mustPurgeCachedBodies,
    resetMessagePagination,
  ]);

  // Update last-refreshed only when every active feed finished successfully (F9).
  // A successful topics poll must not advance the timestamp while messages failed.
  useEffect(() => {
    const topicsWasValidating = topicsValidatingRef.current;
    const messagesWasValidating = messagesValidatingRef.current;
    topicsValidatingRef.current = Boolean(topics.isValidating);
    messagesValidatingRef.current = Boolean(messagesLive.isValidating);

    const topicsJustSettled = topicsWasValidating && !topics.isValidating;
    const messagesJustSettled = messagesWasValidating && !messagesLive.isValidating;
    if (!topicsJustSettled && !messagesJustSettled) return;

    // Wait until all active feeds are idle.
    if (topics.isValidating || messagesLive.isValidating) return;

    // Topics feed is active only with a selected user; messages only with topic.
    const topicsOk = !userId || (!topics.error && topics.data !== undefined);
    const messagesOk =
      !userId || !topicId || (!messagesLive.error && messagesLive.data !== undefined);

    if (topicsOk && messagesOk) {
      setLastRefreshedAt(new Date());
    }
  }, [
    messagesLive.data,
    messagesLive.error,
    messagesLive.isValidating,
    topicId,
    topics.data,
    topics.error,
    topics.isValidating,
    userId,
  ]);

  // Only conversation-domain FORBIDDEN means policy disabled (not policy.get failures).
  const isForbidden = useMemo(() => {
    return [topics.error, messagesLive.error, topicDetail.error].some(isForbiddenError);
  }, [messagesLive.error, topicDetail.error, topics.error]);

  const feedError = useMemo(() => {
    if (isForbidden) return null;
    const err = topics.error ?? messagesLive.error ?? topicDetail.error;
    if (!err) return null;
    return t('audit.live.errors.loadFailed', {
      defaultValue: 'Failed to refresh the live feed. Retry or check connectivity.',
    });
  }, [isForbidden, messagesLive.error, t, topicDetail.error, topics.error]);

  // Sync topic next cursor from head when no older pages accumulated.
  useEffect(() => {
    if (topicOlderPages.length === 0) {
      setTopicNextCursor(topics.data?.nextCursor ?? null);
    }
  }, [topicOlderPages.length, topics.data?.nextCursor]);

  // Message next cursor + gap detection when older pages exist.
  useEffect(() => {
    const head = messagesLive.data?.items ?? [];
    const headIds = new Set(head.map((m) => m.id));

    if (olderPages.length === 0) {
      setOlderNextCursor(messagesLive.data?.nextCursor ?? null);
      prevHeadIdsRef.current = headIds;
      setMessageGap(false);
      return;
    }

    // Full head page with no overlap vs previous head ⇒ possible silent gap while paginated.
    if (
      head.length === MSG_LIMIT &&
      prevHeadIdsRef.current.size > 0 &&
      idSetsDisjoint(headIds, prevHeadIdsRef.current)
    ) {
      setMessageGap(true);
    }
    prevHeadIdsRef.current = headIds;
  }, [messagesLive.data?.items, messagesLive.data?.nextCursor, olderPages.length]);

  const reloadMessages = useCallback(() => {
    setOlderPages([]);
    setOlderNextCursor(null);
    setMessageGap(false);
    prevHeadIdsRef.current = new Set();
    void messagesLive.mutate();
  }, [messagesLive]);

  const loadMoreTopics = useCallback(async () => {
    const next = topicNextCursor;
    if (!next || !userId || loadingMoreTopics) return;
    setLoadingMoreTopics(true);
    setTopicPageError(null);
    try {
      const page = await adminAuditService.listConversations({
        cursor: next,
        limit: LIST_LIMIT,
        userId,
      });
      setTopicOlderPages((p) => [...p, page.items]);
      setTopicNextCursor(page.nextCursor);
    } catch {
      setTopicPageError(
        t('audit.live.errors.loadMoreTopics', {
          defaultValue: 'Failed to load more topics. Try again.',
        }),
      );
    } finally {
      setLoadingMoreTopics(false);
    }
  }, [loadingMoreTopics, t, topicNextCursor, userId]);

  const loadOlderMessages = useCallback(async () => {
    const next = olderNextCursor;
    // Discard pagination once access is revoked (stale in-flight results ignored).
    if (!next || !userId || !topicId || loadingOlder || !canConversationRead || bodyHidden) return;
    const epoch = accessEpochRef.current;
    setLoadingOlder(true);
    setMessagePageError(null);
    try {
      const page = await adminAuditService.listConversationMessages({
        cursor: next,
        includeBody,
        limit: MSG_LIMIT,
        topicId,
        userId,
      });
      // Re-check after await — permission/policy may have been revoked mid-flight.
      if (
        epoch !== accessEpochRef.current ||
        !canConversationRead ||
        bodyHidden ||
        page.contentAccessMode === 'metadata_only' ||
        page.contentAccessMode === 'disabled'
      ) {
        return;
      }
      setOlderPages((p) => [...p, page.items]);
      setOlderNextCursor(page.nextCursor);
    } catch {
      setMessagePageError(
        t('audit.live.errors.loadMoreMessages', {
          defaultValue: 'Failed to load older messages. Try again.',
        }),
      );
    } finally {
      setLoadingOlder(false);
    }
  }, [
    bodyHidden,
    canConversationRead,
    includeBody,
    loadingOlder,
    olderNextCursor,
    t,
    topicId,
    userId,
  ]);

  const allMessages = useMemo(() => {
    if (messagesAccessDenied) return [];
    const latest = messagesLive.data?.items ?? [];
    const merged = mergeMessagePages(olderPages.flat(), latest);
    // Strip bodies if policy/permission revoked while pages still hold cached content.
    return bodyHidden ? stripMessageBodies(merged) : merged;
  }, [bodyHidden, messagesAccessDenied, messagesLive.data?.items, olderPages]);

  const orderedTopics = useMemo(() => {
    const head = topics.data?.items ?? [];
    return mergeTopicPages(head, topicOlderPages);
  }, [topicOlderPages, topics.data?.items]);

  if (isForbidden || contentAccessMode === 'disabled') {
    return <ContentAccessDisabledState />;
  }

  // Hide policy-dependent banners when AUDIT_READ is missing (mode unknown → conservative UI only).
  const showPolicyBanner = canAuditRead && Boolean(contentAccessMode);

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
        ) : showPolicyBanner && contentAccessMode === 'metadata_only' ? (
          <div className={styles.banner} role="status">
            {t('audit.live.banner.metadataOnly')}
          </div>
        ) : null
      }
      toolbar={
        <div className={styles.toolbar}>
          <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
            <AuditUserSearchSelect
              enabled={canConversationRead}
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
            <Button
              size="small"
              type="default"
              onClick={() => {
                void (async () => {
                  try {
                    // All active feeds must succeed before advancing the shared timestamp (F9).
                    await Promise.all([
                      topics.mutate(),
                      messagesLive.mutate(),
                      topicDetail.mutate(),
                    ]);
                    setLastRefreshedAt(new Date());
                  } catch {
                    // SWR error state surfaces via feedError; do not advance refresh time.
                  }
                })();
              }}
            >
              {t('audit.live.filters.refreshNow')}
            </Button>
          )}
        </div>
      }
    >
      {feedError ? (
        <div className={styles.gapBanner} role="alert">
          <Text>{feedError}</Text>
          <Button
            size="small"
            type="primary"
            onClick={() => {
              void (async () => {
                try {
                  await Promise.all([topics.mutate(), messagesLive.mutate(), topicDetail.mutate()]);
                  setLastRefreshedAt(new Date());
                } catch {
                  // Leave lastRefreshedAt unchanged; feedError stays until success.
                }
              })();
            }}
          >
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

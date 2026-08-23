'use client';

import type { TFunction } from 'i18next';
import { useMemo } from 'react';

import { mergeMessagePages, stripMessageBodies } from '../shared/liveMessageUtils';
import {
  emptyRedactionSlots,
  envelopeSlot,
  isRedactionEnvelopeRenderable,
  selectRenderablePages,
} from '../shared/redactionAuthority';
import { mergeTopicPages } from '../shared/topicListUtils';
import { useRedactionAuthority } from '../shared/useRedactionAuthority';
import { useLiveAuditAccess } from './useLiveAuditAccess';
import { useLiveAuditSources } from './useLiveAuditSources';
import { useLiveFeedRefresh } from './useLiveFeedRefresh';
import { useLiveMessageFeed } from './useLiveMessageFeed';
import { useLiveTopicPagination } from './useLiveTopicPagination';

export interface LiveAuditFeedsArgs {
  canAuditRead: boolean;
  canConversationRead: boolean;
  poll: boolean;
  t: TFunction<'admin'>;
  topicId: string | undefined;
  userId: string | undefined;
}

/**
 * Composes the four live-audit feeds (topics list, topic detail, messages, policy) with the
 * redaction authority that may drop already-fetched pages, and exposes only what the page renders.
 * Kept in one hook because the redaction reset callback has to reach both paginators.
 */
export const useLiveAuditFeeds = ({
  canAuditRead,
  canConversationRead,
  poll,
  t,
  topicId,
  userId,
}: LiveAuditFeedsArgs) => {
  const { messagesLive, policy, topicDetail, topics } = useLiveAuditSources({
    canAuditRead,
    canConversationRead,
    poll,
    topicId,
    userId,
  });

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
    loadMoreTopics,
    loadingMoreTopics,
    pageProfiles: topicPageProfiles,
    resetTopicPagination,
    topicNextCursor,
    topicNextCursorProfile,
    topicOlderPages,
    topicPageError,
  } = useLiveTopicPagination({
    accessEpochRef,
    canConversationRead,
    t,
    topics,
    userId,
  });

  const {
    loadOlderMessages,
    loadingOlder,
    messageGap,
    messagePageError,
    olderNextCursor,
    olderNextCursorProfile,
    olderPages: messageOlderPages,
    pageProfiles: messagePageProfiles,
    reloadMessages,
    resetMessagePagination,
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

  const extraObserved = useMemo(
    () => [...messagePageProfiles, ...topicPageProfiles],
    [messagePageProfiles, topicPageProfiles],
  );
  const redaction = useRedactionAuthority(
    {
      ...emptyRedactionSlots(),
      detail: envelopeSlot(topicDetail.data),
      list: envelopeSlot(topics.data),
      messages: envelopeSlot(messagesLive.data),
      policy: canAuditRead ? envelopeSlot(policy.data) : undefined,
    },
    extraObserved,
    `${userId ?? ''}:${topicId ?? ''}`,
    (effective) => {
      const ok = (profile: string | undefined) => isRedactionEnvelopeRenderable(profile, effective);
      const messagesProfile = envelopeSlot(messagesLive.data);
      const topicsProfile = envelopeSlot(topics.data);
      resetMessagePagination(
        ok(messagesProfile)
          ? { cursor: messagesLive.data?.nextCursor ?? null, redactionProfile: messagesProfile }
          : { cursor: null },
      );
      resetTopicPagination(
        ok(topicsProfile)
          ? { cursor: topics.data?.nextCursor ?? null, redactionProfile: topicsProfile }
          : { cursor: null },
      );
      accessEpochRef.current += 1;
    },
  );

  const messagesCursorRenderable = redaction.isEnvelopeRenderable(olderNextCursorProfile);
  const topicsCursorRenderable = redaction.isEnvelopeRenderable(topicNextCursorProfile);

  // R2: drop looser pages in this render, before merge, so they never commit.
  const orderedTopics = useMemo(() => {
    const headRenderable = redaction.isEnvelopeRenderable(envelopeSlot(topics.data));
    return mergeTopicPages(
      headRenderable ? (topics.data?.items ?? []) : [],
      topicOlderPages
        .filter((page) => redaction.isEnvelopeRenderable(page.redactionProfile))
        .map((page) => page.items),
    );
  }, [redaction, topicOlderPages, topics.data]);

  const allMessages = useMemo(() => {
    if (messagesAccessDenied) return [];
    const pages = [
      { items: messagesLive.data?.items ?? [], redactionProfile: envelopeSlot(messagesLive.data) },
      ...messageOlderPages,
    ];
    const merged = mergeMessagePages(
      selectRenderablePages(pages, redaction.isEnvelopeRenderable),
      [],
    );
    return bodyHidden ? stripMessageBodies(merged) : merged;
  }, [bodyHidden, messageOlderPages, messagesAccessDenied, messagesLive.data, redaction]);

  const topicForPane = redaction.isEnvelopeRenderable(envelopeSlot(topicDetail.data))
    ? topicDetail.data
    : undefined;

  const { lastRefreshedAt, refreshAllFeeds } = useLiveFeedRefresh({
    messagesLive,
    topicDetail,
    topicId,
    topics,
    userId,
  });

  return {
    access: {
      bodyHidden,
      contentAccessMode,
      feedError,
      isForbidden,
      messagesAccessDenied,
      showPolicyBanner,
    },
    messages: {
      gap: messageGap,
      // Cursor pages fetched under a looser redaction profile must not be reachable.
      hasOlder: messagesCursorRenderable && Boolean(olderNextCursor) && canConversationRead,
      items: allMessages,
      loadOlder: () => {
        if (!messagesCursorRenderable) return;
        void loadOlderMessages();
      },
      loading: messagesLive.isLoading && !messagesLive.data,
      loadingOlder,
      pageError: messagePageError,
      reload: reloadMessages,
      topic: topicForPane,
    },
    refresh: { lastRefreshedAt, refreshAllFeeds },
    topics: {
      hasMore: topicsCursorRenderable && Boolean(topicNextCursor),
      items: orderedTopics,
      loadMore: () => {
        if (!topicsCursorRenderable) return;
        void loadMoreTopics();
      },
      loading: (topics.isLoading && !topics.data) || loadingMoreTopics,
      pageError: topicPageError,
    },
  };
};

export type LiveAuditFeeds = ReturnType<typeof useLiveAuditFeeds>;

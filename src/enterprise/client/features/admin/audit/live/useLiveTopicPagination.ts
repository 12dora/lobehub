'use client';

import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AdminAuditConversationListItem } from '@/enterprise/client/services/adminAudit';
import { adminAuditService } from '@/enterprise/client/services/adminAudit';

import type { AuditRedactionProfile } from '../shared/liveMessageUtils';
import { envelopeSlot } from '../shared/redactionAuthority';
import { mergeTopicPages } from '../shared/topicListUtils';
import type { LiveFeedSWR } from './useLiveAuditAccess';

export const TOPIC_LIST_LIMIT = 30;

export interface ProfiledTopicPage {
  items: AdminAuditConversationListItem[];
  redactionProfile: string | undefined;
}

export const useLiveTopicPagination = ({
  accessEpochRef,
  canConversationRead,
  t,
  topics,
  userId,
}: {
  accessEpochRef: { current: number };
  canConversationRead: boolean;
  t: TFunction<'admin'>;
  topics: LiveFeedSWR<{
    items?: AdminAuditConversationListItem[];
    nextCursor?: string | null;
    redactionProfile?: AuditRedactionProfile;
  }> & { isLoading?: boolean };
  userId?: string;
}) => {
  // Topics: always poll head (no cursor); accumulate older pages for "load more".
  const [topicOlderPages, setTopicOlderPages] = useState<ProfiledTopicPage[]>([]);
  const [topicNextCursor, setTopicNextCursor] = useState<string | null>(null);
  const [loadingMoreTopics, setLoadingMoreTopics] = useState(false);
  const [topicPageError, setTopicPageError] = useState<string | null>(null);

  const resetTopicPagination = useCallback(() => {
    setTopicOlderPages([]);
    setTopicNextCursor(null);
  }, []);

  useEffect(() => {
    resetTopicPagination();
  }, [resetTopicPagination, userId]);

  // Sync topic next cursor from head when no older pages accumulated.
  useEffect(() => {
    if (topicOlderPages.length === 0) {
      setTopicNextCursor(topics.data?.nextCursor ?? null);
    }
  }, [topicOlderPages.length, topics.data?.nextCursor]);

  const loadMoreTopics = useCallback(async () => {
    const next = topicNextCursor;
    if (!next || !userId || loadingMoreTopics || !canConversationRead) return;
    const epoch = accessEpochRef.current;
    setLoadingMoreTopics(true);
    setTopicPageError(null);
    try {
      const page = await adminAuditService.listConversations({
        cursor: next,
        limit: TOPIC_LIST_LIMIT,
        userId,
      });
      if (epoch !== accessEpochRef.current) return;
      setTopicOlderPages((p) => [
        ...p,
        { items: page.items, redactionProfile: envelopeSlot(page) },
      ]);
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
  }, [accessEpochRef, canConversationRead, loadingMoreTopics, t, topicNextCursor, userId]);

  const pageProfiles = useMemo(
    () => topicOlderPages.map((page) => page.redactionProfile),
    [topicOlderPages],
  );

  const orderedTopics = useMemo(() => {
    const head = topics.data?.items ?? [];
    return mergeTopicPages(
      head,
      topicOlderPages.map((page) => page.items),
    );
  }, [topicOlderPages, topics.data?.items]);

  return {
    loadMoreTopics,
    loadingMoreTopics,
    orderedTopics,
    pageProfiles,
    topicNextCursor,
    topicOlderPages,
    topicPageError,
    topics,
  };
};

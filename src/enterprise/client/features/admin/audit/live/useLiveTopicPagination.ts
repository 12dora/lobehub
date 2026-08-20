'use client';

import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AdminAuditConversationListItem } from '@/enterprise/client/services/adminAudit';
import { adminAuditService } from '@/enterprise/client/services/adminAudit';

import type { AuditRedactionProfile } from '../shared/liveMessageUtils';
import { mergeTopicPages } from '../shared/topicListUtils';
import type { LiveFeedSWR } from './useLiveAuditAccess';

export const TOPIC_LIST_LIMIT = 30;

export const useLiveTopicPagination = ({
  accessEpochRef,
  canConversationRead,
  redactionProfile,
  t,
  topics,
  userId,
}: {
  accessEpochRef: { current: number };
  canConversationRead: boolean;
  redactionProfile: AuditRedactionProfile | undefined;
  t: TFunction<'admin'>;
  topics: LiveFeedSWR<{
    items?: AdminAuditConversationListItem[];
    nextCursor?: string | null;
    redactionProfile?: AuditRedactionProfile;
  }> & { isLoading?: boolean };
  userId?: string;
}) => {
  // Topics: always poll head (no cursor); accumulate older pages for "load more".
  const [topicOlderPages, setTopicOlderPages] = useState<AdminAuditConversationListItem[][]>([]);
  const [topicNextCursor, setTopicNextCursor] = useState<string | null>(null);
  const [loadingMoreTopics, setLoadingMoreTopics] = useState(false);
  const [topicPageError, setTopicPageError] = useState<string | null>(null);

  const resetTopicPagination = useCallback(() => {
    setTopicOlderPages([]);
    setTopicNextCursor(null);
  }, []);

  useEffect(() => {
    resetTopicPagination();
  }, [redactionProfile, resetTopicPagination, userId]);

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
      if (
        epoch !== accessEpochRef.current ||
        (page.redactionProfile !== undefined &&
          redactionProfile !== undefined &&
          page.redactionProfile !== redactionProfile)
      ) {
        return;
      }
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
  }, [
    accessEpochRef,
    canConversationRead,
    loadingMoreTopics,
    redactionProfile,
    t,
    topicNextCursor,
    userId,
  ]);

  const orderedTopics = useMemo(() => {
    const head = topics.data?.items ?? [];
    return mergeTopicPages(head, topicOlderPages);
  }, [topicOlderPages, topics.data?.items]);

  return {
    loadMoreTopics,
    loadingMoreTopics,
    orderedTopics,
    topicNextCursor,
    topicPageError,
    topics,
  };
};

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { LiveFeedSWR } from './useLiveAuditAccess';

export const useLiveFeedRefresh = ({
  messagesLive,
  topicDetail,
  topicId,
  topics,
  userId,
}: {
  messagesLive: LiveFeedSWR<unknown>;
  topicDetail: LiveFeedSWR<unknown>;
  topicId?: string;
  topics: LiveFeedSWR<unknown>;
  userId?: string;
}) => {
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const topicsValidatingRef = useRef(false);
  const messagesValidatingRef = useRef(false);

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

  const refreshAllFeeds = useCallback(async () => {
    try {
      // All active feeds must succeed before advancing the shared timestamp (F9).
      await Promise.all([topics.mutate(), messagesLive.mutate(), topicDetail.mutate()]);
      setLastRefreshedAt(new Date());
    } catch {
      // SWR error state surfaces via feedError; do not advance refresh time.
    }
  }, [messagesLive, topicDetail, topics]);

  return { lastRefreshedAt, refreshAllFeeds };
};

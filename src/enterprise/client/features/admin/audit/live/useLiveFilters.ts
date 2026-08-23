'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useIsPollGateOpen } from '@/enterprise/client/shared/useVisiblePoll';

export interface LiveFiltersState {
  live: boolean;
  onUserChange: (id: string | undefined) => void;
  /** Whether the tab is visible/online — drives both the live dot and the poll interval. */
  pageVisible: boolean;
  /** True only when live mode, page visibility and conversation permission all allow polling. */
  poll: boolean;
  setLive: (live: boolean) => void;
  setTopicId: (topicId: string | undefined) => void;
  topicId: string | undefined;
  userId: string | undefined;
}

/** Subject/topic selection + live-poll switch for the audit live page. */
export const useLiveFilters = (canConversationRead: boolean): LiveFiltersState => {
  const [searchParams] = useSearchParams();

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

  return { live, onUserChange, pageVisible, poll, setLive, setTopicId, topicId, userId };
};

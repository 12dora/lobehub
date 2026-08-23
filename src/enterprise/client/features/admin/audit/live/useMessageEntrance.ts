'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';

import type { AdminAuditConversationMessage } from '@/enterprise/client/services/adminAudit';

export interface MessageEntranceArgs {
  loadingOlder?: boolean;
  /** Chronologically ordered stream, exactly as rendered. */
  ordered: AdminAuditConversationMessage[];
  reduceMotion: boolean | null;
  topicId?: string;
}

/**
 * Ids that should play the one-time entrance animation this render.
 *
 * Framer captures `initial` on mount, so entrance candidates are derived during render
 * from the last committed snapshot. The snapshot itself advances after commit — abandoned or
 * concurrent renders must not consume a message's one-time entrance animation.
 */
export const useMessageEntrance = ({
  loadingOlder,
  ordered,
  reduceMotion,
  topicId,
}: MessageEntranceArgs): Set<string> => {
  // Last committed stream snapshot. Render only reads it.
  const committedStreamRef = useRef<{
    committed: boolean;
    ids: string[];
    topicId?: string;
  }>({ committed: false, ids: [], topicId: undefined });

  const enterIds = useMemo(() => {
    const committed = committedStreamRef.current;
    const currentIds = ordered.map((msg) => msg.id);
    const sameCommittedTopic = committed.committed && committed.topicId === topicId;
    const knownList = sameCommittedTopic ? committed.ids : [];
    const known = new Set(knownList);
    const fresh = currentIds.filter((id) => !known.has(id));

    let nextEnter = new Set<string>();
    if (
      !reduceMotion &&
      !loadingOlder &&
      sameCommittedTopic &&
      knownList.length > 0 &&
      fresh.length > 0
    ) {
      // Append-only: previous order is an exact prefix; all fresh ids form the contiguous tail.
      const isAppend =
        currentIds.length === knownList.length + fresh.length &&
        knownList.every((id, i) => currentIds[i] === id);
      if (isAppend) nextEnter = new Set(fresh);
    }

    return nextEnter;
  }, [loadingOlder, ordered, reduceMotion, topicId]);

  useLayoutEffect(() => {
    committedStreamRef.current = {
      committed: true,
      ids: ordered.map((message) => message.id),
      topicId,
    };
  }, [ordered, topicId]);

  return enterIds;
};

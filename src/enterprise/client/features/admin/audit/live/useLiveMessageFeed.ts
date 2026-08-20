'use client';

import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AdminAuditConversationMessage } from '@/enterprise/client/services/adminAudit';
import { adminAuditService } from '@/enterprise/client/services/adminAudit';

import {
  type AuditContentAccessMode,
  type AuditRedactionProfile,
  mergeMessagePages,
  stripMessageBodies,
} from '../shared/liveMessageUtils';
import { envelopeSlot } from '../shared/redactionAuthority';
import { idSetsDisjoint } from '../shared/topicListUtils';
import type { LiveFeedSWR } from './useLiveAuditAccess';

export const MSG_LIMIT = 100;

export interface ProfiledMessagePage {
  items: AdminAuditConversationMessage[];
  redactionProfile: string | undefined;
}

export interface PaginationSeed {
  cursor: string | null;
  redactionProfile?: string;
}

export const useLiveMessageFeed = ({
  accessEpochRef,
  bodyHidden,
  canConversationRead,
  contentAccessMode,
  includeBody,
  messagesAccessDenied,
  messagesLive,
  mustPurgeCachedBodies,
  t,
  topicId,
  userId,
}: {
  accessEpochRef: { current: number };
  bodyHidden: boolean;
  canConversationRead: boolean;
  contentAccessMode: AuditContentAccessMode | undefined;
  includeBody: boolean;
  messagesAccessDenied: boolean;
  messagesLive: LiveFeedSWR<{
    contentAccessMode?: AuditContentAccessMode;
    items?: AdminAuditConversationMessage[];
    nextCursor?: string | null;
    redactionProfile?: AuditRedactionProfile;
  }>;
  mustPurgeCachedBodies: boolean;
  t: TFunction<'admin'>;
  topicId?: string;
  userId?: string;
}) => {
  // Messages: poll head; accumulate older pages with the envelope they were loaded under.
  const [olderPages, setOlderPages] = useState<ProfiledMessagePage[]>([]);
  const [olderNextCursor, setOlderNextCursor] = useState<string | null>(null);
  const [olderNextCursorProfile, setOlderNextCursorProfile] = useState<string | undefined>(
    undefined,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messageGap, setMessageGap] = useState(false);
  const [messagePageError, setMessagePageError] = useState<string | null>(null);
  const prevHeadIdsRef = useRef<Set<string>>(new Set());
  const messagesHeadRef = useRef(messagesLive.data);
  messagesHeadRef.current = messagesLive.data;

  const resetMessagePagination = useCallback((seed?: PaginationSeed) => {
    setOlderPages([]);
    // Reseed atomically from the (renderable) head. Never park at null when
    // the head cursor is unchanged — the sync effect would not re-run.
    // Keep this callback stable: it is an effect dep for topic/user changes.
    const head = messagesHeadRef.current;
    if (seed) {
      setOlderNextCursor(seed.cursor);
      setOlderNextCursorProfile(seed.redactionProfile);
    } else {
      setOlderNextCursor(head?.nextCursor ?? null);
      setOlderNextCursorProfile(envelopeSlot(head));
    }
    setMessageGap(false);
    prevHeadIdsRef.current = new Set();
  }, []);

  useEffect(() => {
    resetMessagePagination();
  }, [resetMessagePagination, topicId, userId]);

  // Drop cached body-bearing pages when policy or conversation permission is lost
  // so previously loaded content cannot outlive authorization.
  useEffect(() => {
    if (mustPurgeCachedBodies || !includeBody) {
      resetMessagePagination();
    }
  }, [
    canConversationRead,
    contentAccessMode,
    includeBody,
    mustPurgeCachedBodies,
    resetMessagePagination,
  ]);

  // Message next cursor + gap detection when older pages exist.
  useEffect(() => {
    const head = messagesLive.data?.items ?? [];
    const headIds = new Set(head.map((m) => m.id));

    if (olderPages.length === 0) {
      setOlderNextCursor(messagesLive.data?.nextCursor ?? null);
      setOlderNextCursorProfile(envelopeSlot(messagesLive.data));
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
    setOlderNextCursor(messagesLive.data?.nextCursor ?? null);
    setOlderNextCursorProfile(envelopeSlot(messagesLive.data));
    setMessageGap(false);
    prevHeadIdsRef.current = new Set();
    void messagesLive.mutate();
  }, [messagesLive]);

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
      setOlderPages((p) => [...p, { items: page.items, redactionProfile: envelopeSlot(page) }]);
      setOlderNextCursor(page.nextCursor);
      setOlderNextCursorProfile(envelopeSlot(page));
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
    accessEpochRef,
    bodyHidden,
    canConversationRead,
    includeBody,
    loadingOlder,
    olderNextCursor,
    t,
    topicId,
    userId,
  ]);

  const pageProfiles = useMemo(() => olderPages.map((page) => page.redactionProfile), [olderPages]);

  const allMessages = useMemo(() => {
    if (messagesAccessDenied) return [];
    const latest = messagesLive.data?.items ?? [];
    const merged = mergeMessagePages(
      olderPages.flatMap((page) => page.items),
      latest,
    );
    return bodyHidden ? stripMessageBodies(merged) : merged;
  }, [bodyHidden, messagesAccessDenied, messagesLive.data?.items, olderPages]);

  return {
    allMessages,
    loadOlderMessages,
    loadingOlder,
    messageGap,
    messagePageError,
    olderNextCursor,
    olderNextCursorProfile,
    olderPages,
    pageProfiles,
    reloadMessages,
    resetMessagePagination,
  };
};

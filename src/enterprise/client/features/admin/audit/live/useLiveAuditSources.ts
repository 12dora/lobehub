'use client';

import {
  useFetchAuditConversation,
  useFetchAuditConversationMessages,
  useFetchAuditConversationsList,
  useFetchAuditPolicy,
} from '../hooks/useAdminAudit';
import { AUDIT_LIST_POLL_MS } from '../shared/useCursorPagination';
import { MSG_LIMIT } from './useLiveMessageFeed';
import { TOPIC_LIST_LIMIT } from './useLiveTopicPagination';

export interface LiveAuditSourcesArgs {
  canAuditRead: boolean;
  canConversationRead: boolean;
  poll: boolean;
  topicId: string | undefined;
  userId: string | undefined;
}

/** The four server feeds behind the live page. Head pages only — paging lives in its own hooks. */
export const useLiveAuditSources = ({
  canAuditRead,
  canConversationRead,
  poll,
  topicId,
  userId,
}: LiveAuditSourcesArgs) => {
  const topics = useFetchAuditConversationsList(
    {
      limit: TOPIC_LIST_LIMIT,
      userId: userId!,
    },
    canConversationRead && !!userId,
    { refreshInterval: poll && !!userId ? AUDIT_LIST_POLL_MS : 0 },
  );

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

  return { messagesLive, policy, topicDetail, topics };
};

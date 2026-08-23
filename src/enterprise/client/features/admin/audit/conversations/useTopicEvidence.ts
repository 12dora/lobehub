'use client';

import type { TFunction } from 'i18next';
import { useCallback, useMemo, useState } from 'react';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import {
  useFetchAuditConversation,
  useFetchAuditConversationMessages,
  useFetchAuditPolicy,
} from '../hooks/useAdminAudit';
import { emptyRedactionSlots, envelopeSlot } from '../shared/redactionAuthority';
import { useRedactionAuthority } from '../shared/useRedactionAuthority';
import { useSummaryFailureToast } from '../shared/useSummaryFailureToast';

export interface TopicEvidenceArgs {
  canAuditRead: boolean;
  canConversationRead: boolean;
  t: TFunction<'admin'>;
  topicId: string;
  userId: string;
}

/**
 * Fetches one topic's evidence (detail + message page + policy) under the redaction authority,
 * and owns the body-reveal confirmation and the cursor stack that page through the messages.
 */
export const useTopicEvidence = ({
  canAuditRead,
  canConversationRead,
  t,
  topicId,
  userId,
}: TopicEvidenceArgs) => {
  const [includeBody, setIncludeBody] = useState(false);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const currentCursor = cursorStack.at(-1) ?? null;

  const policy = useFetchAuditPolicy(canAuditRead);
  const detail = useFetchAuditConversation(
    userId,
    topicId,
    canConversationRead && !!userId && !!topicId,
  );
  const messages = useFetchAuditConversationMessages(
    {
      cursor: currentCursor,
      includeBody,
      limit: 50,
      topicId,
      userId,
    },
    canConversationRead && !!userId && !!topicId,
  );

  // Only conversation evidence failures deny the page — not optional policy metadata.
  const isForbidden = useMemo(() => {
    const errors = [detail.error, messages.error];
    return errors.some((err) => {
      if (!err) return false;
      const data = (err as { data?: { code?: string } }).data;
      return data?.code === 'FORBIDDEN';
    });
  }, [detail.error, messages.error]);
  // A revalidation failure with cached detail is still degraded: preserve the stale
  // evidence, but make its freshness failure explicit and retryable.
  const detailFailed = Boolean(detail.error) && !isForbidden;

  useSummaryFailureToast(detailFailed, t);

  // Prefer contentAccessMode from conversation/messages (available with CONVERSATION_READ).
  const contentAccessMode =
    messages.data?.contentAccessMode ??
    detail.data?.contentAccessMode ??
    (canAuditRead ? policy.data?.contentAccessMode : undefined);

  const redaction = useRedactionAuthority(
    {
      ...emptyRedactionSlots(),
      detail: envelopeSlot(detail.data),
      messages: envelopeSlot(messages.data),
      policy: canAuditRead ? envelopeSlot(policy.data) : undefined,
    },
    [],
    `${userId}:${topicId}`,
    () => {
      setCursorStack([]);
    },
  );
  const detailRenderable = redaction.isEnvelopeRenderable(envelopeSlot(detail.data));
  const messagesRenderable = redaction.isEnvelopeRenderable(envelopeSlot(messages.data));

  const onToggleBody = useCallback(
    (checked: boolean) => {
      if (!checked) {
        setIncludeBody(false);
        setCursorStack([]);
        return;
      }
      openDangerConfirm({
        content: t('audit.conversations.topic.loadBodyConfirm'),
        title: t('audit.conversations.topic.loadBodyTitle'),
        onConfirm: () => {
          setIncludeBody(true);
          setCursorStack([]);
        },
      });
    },
    [t],
  );

  return {
    contentAccessMode,
    detail: {
      failed: detailFailed,
      retry: () => void detail.mutate(),
      // Stale detail fetched under a looser redaction profile must not render.
      topic: detailRenderable ? detail.data : undefined,
    },
    includeBody,
    isForbidden,
    messages: {
      hasData: Boolean(messages.data),
      hasError: Boolean(messages.error),
      isLoading: messages.isLoading,
      items: messagesRenderable ? (messages.data?.items ?? []) : [],
      retry: () => void messages.mutate(),
    },
    onToggleBody,
    pager: {
      hasNext: messagesRenderable && Boolean(messages.data?.nextCursor),
      hasPrevious: messagesRenderable && cursorStack.length > 0,
      onNext: () => {
        if (!messagesRenderable) return;
        const next = messages.data?.nextCursor;
        if (next) setCursorStack((p) => [...p, next]);
      },
      onPrevious: () => {
        if (!messagesRenderable) return;
        setCursorStack((p) => p.slice(0, -1));
      },
    },
  };
};

export type TopicEvidence = ReturnType<typeof useTopicEvidence>;

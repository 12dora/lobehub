'use client';

import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef } from 'react';

import { type AuditContentAccessMode, resolveLiveBodyAccess } from '../shared/liveMessageUtils';

export interface LiveFeedSWR<T = unknown> {
  data: T | undefined;
  error: unknown;
  isValidating: boolean;
  // Call-only: `mutate()` revalidates; `mutate(undefined, { revalidate: false })` drops the head.
  // First arg is `undefined` (not `T`) so KeyedMutator<Concrete> stays assignable (contravariance).
  mutate: (data?: undefined, opts?: { revalidate?: boolean }) => Promise<unknown>;
}

const isForbiddenError = (err: unknown) =>
  Boolean(err && (err as { data?: { code?: string } }).data?.code === 'FORBIDDEN');

export const useLiveAuditAccess = ({
  canAuditRead,
  canConversationRead,
  messagesLive,
  policy,
  t,
  topicDetail,
  topicId,
  topics,
  userId,
}: {
  canAuditRead: boolean;
  canConversationRead: boolean;
  messagesLive: LiveFeedSWR<{ contentAccessMode?: AuditContentAccessMode }>;
  policy: LiveFeedSWR<{ contentAccessMode?: AuditContentAccessMode }>;
  t: TFunction<'admin'>;
  topicDetail: LiveFeedSWR<{ contentAccessMode?: AuditContentAccessMode }>;
  topicId?: string;
  topics: LiveFeedSWR<unknown>;
  userId?: string;
}) => {
  // policy.get requires AUDIT_READ — do not gate on conversation-only permission.
  // Prefer authoritative contentAccessMode from the polled messages response so a
  // remote policy transition (e.g. content_allowed → metadata_only) is observed
  // even when the non-polling policy hook is stale.
  // Sticky polled mode: after SWR head purge we must not fall back to a stale
  // policy.get snapshot and re-enable body serving until the next authorized poll.
  const lastPolledModeRef = useRef<AuditContentAccessMode | undefined>(undefined);

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

  const mutateMessages = messagesLive.mutate;
  const mutateMessagesRef = useRef(mutateMessages);
  mutateMessagesRef.current = mutateMessages;

  // Drop cached body-bearing pages + SWR head when policy or conversation
  // permission is lost so previously loaded content cannot outlive authorization.
  useEffect(() => {
    if (liveAccess.mustPurgeCachedBodies) {
      // Clear SWR head so revoked permission/policy cannot keep serving prior bodies.
      void mutateMessagesRef.current(undefined, { revalidate: false });
    }
    // messagesLive.mutate identity is stable enough for access-edge effects.
  }, [canConversationRead, contentAccessMode, includeBody, liveAccess.mustPurgeCachedBodies]);

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

  // Hide policy-dependent banners when AUDIT_READ is missing (mode unknown → conservative UI only).
  const showPolicyBanner = canAuditRead && Boolean(contentAccessMode);

  return {
    accessEpochRef,
    bodyHidden,
    contentAccessMode,
    feedError,
    includeBody,
    isForbidden,
    liveAccess,
    messagesAccessDenied,
    showPolicyBanner,
  };
};

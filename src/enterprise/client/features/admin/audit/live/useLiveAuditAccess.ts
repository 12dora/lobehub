'use client';

import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef } from 'react';

import { type AuditContentAccessMode, resolveLiveBodyAccess } from '../shared/liveMessageUtils';
import { purgeAuditConversationEvidenceCaches } from '../shared/purgeConversationEvidence';

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

type PolledAuditEnvelope = {
  contentAccessMode?: AuditContentAccessMode;
};

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
  messagesLive: LiveFeedSWR<PolledAuditEnvelope>;
  policy: LiveFeedSWR<PolledAuditEnvelope>;
  t: TFunction<'admin'>;
  topicDetail: LiveFeedSWR<PolledAuditEnvelope>;
  topicId?: string;
  topics: LiveFeedSWR;
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
    const polled = messagesLive.data?.contentAccessMode;
    if (polled) lastPolledModeRef.current = polled;
  }, [messagesLive.data?.contentAccessMode]);

  useEffect(() => {
    lastPolledModeRef.current = undefined;
  }, [userId, topicId]);

  const contentAccessMode =
    messagesLive.data?.contentAccessMode ??
    lastPolledModeRef.current ??
    topicDetail.data?.contentAccessMode ??
    policy.data?.contentAccessMode;

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

  // Drop evidence caches when conversation content access is lost. Redaction
  // disagreement purges are latched inside useRedactionAuthority (once per epoch).
  useEffect(() => {
    if (liveAccess.mustPurgeCachedBodies) {
      void purgeAuditConversationEvidenceCaches();
    }
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

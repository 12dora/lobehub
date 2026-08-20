'use client';

import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef } from 'react';

import {
  type AuditContentAccessMode,
  type AuditRedactionProfile,
  isRedactionProfileTightening,
  pickMostRestrictiveRedactionProfile,
  rankRedactionProfile,
  resolveLiveBodyAccess,
} from '../shared/liveMessageUtils';
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
  redactionProfile?: AuditRedactionProfile;
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
  topics: LiveFeedSWR<PolledAuditEnvelope>;
  userId?: string;
}) => {
  // policy.get requires AUDIT_READ — do not gate on conversation-only permission.
  // Prefer authoritative contentAccessMode from the polled messages response so a
  // remote policy transition (e.g. content_allowed → metadata_only) is observed
  // even when the non-polling policy hook is stale.
  // Sticky polled mode: after SWR head purge we must not fall back to a stale
  // policy.get snapshot and re-enable body serving until the next authorized poll.
  const lastPolledModeRef = useRef<AuditContentAccessMode | undefined>(undefined);
  const lastPolledProfileRef = useRef<AuditRedactionProfile | undefined>(undefined);
  const prevRedactionProfileRef = useRef<AuditRedactionProfile | undefined>(undefined);

  useEffect(() => {
    const polled = messagesLive.data?.contentAccessMode;
    if (polled) lastPolledModeRef.current = polled;
  }, [messagesLive.data?.contentAccessMode]);

  // Reset sticky mode when the operator switches topic/user so we re-resolve fresh.
  useEffect(() => {
    lastPolledModeRef.current = undefined;
    lastPolledProfileRef.current = undefined;
    prevRedactionProfileRef.current = undefined;
  }, [userId, topicId]);

  const contentAccessMode =
    messagesLive.data?.contentAccessMode ??
    lastPolledModeRef.current ??
    topicDetail.data?.contentAccessMode ??
    policy.data?.contentAccessMode;

  // Most restrictive observed profile across every envelope. A stale messages
  // `'off'` must not outrank a topics/policy `'strict'` (fail closed).
  const observedRedactionProfile = pickMostRestrictiveRedactionProfile([
    messagesLive.data?.redactionProfile,
    topicDetail.data?.redactionProfile,
    topics.data?.redactionProfile,
    policy.data?.redactionProfile,
  ]);
  const redactionProfile = observedRedactionProfile ?? lastPolledProfileRef.current;

  useEffect(() => {
    if (observedRedactionProfile) lastPolledProfileRef.current = observedRedactionProfile;
  }, [observedRedactionProfile]);

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
  }, [canConversationRead, contentAccessMode, includeBody, redactionProfile]);

  // Drop every conversation-evidence SWR key (all cursors/topics, not just the
  // active bound mutate) when policy or conversation permission is lost.
  useEffect(() => {
    if (liveAccess.mustPurgeCachedBodies) {
      void purgeAuditConversationEvidenceCaches();
    }
  }, [canConversationRead, contentAccessMode, includeBody, liveAccess.mustPurgeCachedBodies]);

  // Observed tightening, or a source still reporting a looser profile than the
  // computed authority (stale messages `'off'` vs topics/policy `'strict'`).
  useEffect(() => {
    const prev = prevRedactionProfileRef.current;
    if (redactionProfile) prevRedactionProfileRef.current = redactionProfile;

    const computedRank = rankRedactionProfile(redactionProfile);
    const staleLooseSource = [
      messagesLive.data?.redactionProfile,
      topicDetail.data?.redactionProfile,
      topics.data?.redactionProfile,
      policy.data?.redactionProfile,
    ].some((profile) => {
      const rank = rankRedactionProfile(profile);
      return rank !== undefined && computedRank !== undefined && computedRank > rank;
    });
    const tightened =
      Boolean(prev) &&
      Boolean(redactionProfile) &&
      isRedactionProfileTightening(prev, redactionProfile);
    if (!tightened && !staleLooseSource) return;
    void purgeAuditConversationEvidenceCaches();
  }, [
    messagesLive.data?.redactionProfile,
    policy.data?.redactionProfile,
    redactionProfile,
    topicDetail.data?.redactionProfile,
    topics.data?.redactionProfile,
  ]);

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
    redactionProfile,
    showPolicyBanner,
  };
};

/** Near-bottom threshold (px) for auto-scroll while live updates arrive. */
export const LIVE_SCROLL_BOTTOM_THRESHOLD_PX = 80;

export type AuditContentAccessMode = 'content_allowed' | 'metadata_only' | 'disabled';

export interface TimedMessage {
  createdAt: Date | string | number;
  id: string;
}

/**
 * Sort messages ascending by createdAt, then id for stability.
 * Dedupes by id (last write wins) so polled pages can merge safely.
 */
export const sortMessagesChronological = <T extends TimedMessage>(messages: T[]): T[] => {
  const byId = new Map<string, T>();
  for (const m of messages) {
    byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
};

/**
 * Merge older page into existing stream (older messages prepend in chrono order after sort).
 */
export const mergeMessagePages = <T extends TimedMessage>(existing: T[], incoming: T[]): T[] =>
  sortMessagesChronological([...existing, ...incoming]);

type WithOptionalContent = TimedMessage & { content?: string | null };

/**
 * Drop retained message bodies when policy/permission no longer allows them.
 * Used by live view so cached pages cannot outlive authorization.
 */
export const stripMessageBodies = <T extends WithOptionalContent>(messages: T[]): T[] =>
  messages.map((m) => (m.content == null ? m : { ...m, content: null }));

export interface LiveBodyAccess {
  /** Conceal bodies in the UI (policy or permission denied). */
  bodyHidden: boolean;
  /** Whether the client may request message bodies on the next poll. */
  includeBody: boolean;
  /** Drop SWR head + older pages so revoked content cannot linger. */
  mustPurgeCachedBodies: boolean;
  /** Permission fully gone or content access disabled — stop the stream UI. */
  stopServing: boolean;
}

/**
 * Re-evaluate body access on every live poll/stream tick.
 * Both conversation permission and contentAccessMode are authoritative.
 */
export const resolveLiveBodyAccess = (params: {
  canConversationRead: boolean;
  contentAccessMode: AuditContentAccessMode | null | undefined;
}): LiveBodyAccess => {
  const mode = params.contentAccessMode ?? null;
  const canRead = params.canConversationRead;
  const allowed = canRead && mode === 'content_allowed';
  return {
    // Unknown mode → hide bodies until a poll authoritatively allows them.
    bodyHidden: !allowed,
    includeBody: allowed,
    // Only purge when we know access was lost — not while mode is still loading.
    mustPurgeCachedBodies: !canRead || mode === 'metadata_only' || mode === 'disabled',
    stopServing: !canRead || mode === 'disabled',
  };
};

/**
 * True when the scroll container is near the bottom (within threshold).
 * Used so live append only auto-scrolls when the operator is following the tail.
 */
export const isNearBottom = (
  el: { clientHeight: number; scrollHeight: number; scrollTop: number },
  thresholdPx: number = LIVE_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean => {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= thresholdPx;
};

/** Format a relative time string in English-ish compact form (i18n applied by caller when needed). */
export const relativeTimeMs = (
  value: Date | string | number,
  nowMs: number = Date.now(),
): number => {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, nowMs - t);
};

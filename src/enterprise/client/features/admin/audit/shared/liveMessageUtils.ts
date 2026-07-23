/** Near-bottom threshold (px) for auto-scroll while live updates arrive. */
export const LIVE_SCROLL_BOTTOM_THRESHOLD_PX = 80;

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

import { describe, expect, it } from 'vitest';

import {
  isNearBottom,
  LIVE_SCROLL_BOTTOM_THRESHOLD_PX,
  mergeMessagePages,
  relativeTimeMs,
  sortMessagesChronological,
} from './liveMessageUtils';

describe('liveMessageUtils', () => {
  it('sorts messages by createdAt ascending', () => {
    const sorted = sortMessagesChronological([
      { createdAt: '2026-01-02T00:00:00.000Z', id: 'b' },
      { createdAt: '2026-01-01T00:00:00.000Z', id: 'a' },
      { createdAt: '2026-01-03T00:00:00.000Z', id: 'c' },
    ]);
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('dedupes by id when merging pages', () => {
    const merged = mergeMessagePages(
      [{ createdAt: '2026-01-02T00:00:00.000Z', id: 'b', text: 'old' }],
      [
        { createdAt: '2026-01-01T00:00:00.000Z', id: 'a', text: 'a' },
        { createdAt: '2026-01-02T00:00:00.000Z', id: 'b', text: 'new' },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.id === 'b')).toMatchObject({ text: 'new' });
    expect(merged[0]!.id).toBe('a');
  });

  it('detects near-bottom within threshold', () => {
    const el = { clientHeight: 400, scrollHeight: 1000, scrollTop: 520 };
    // distance = 1000 - 520 - 400 = 80
    expect(isNearBottom(el, LIVE_SCROLL_BOTTOM_THRESHOLD_PX)).toBe(true);
    expect(isNearBottom({ ...el, scrollTop: 400 }, LIVE_SCROLL_BOTTOM_THRESHOLD_PX)).toBe(false);
  });

  it('computes relative age in ms', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    expect(relativeTimeMs('2026-01-01T11:59:00.000Z', now)).toBe(60_000);
  });
});

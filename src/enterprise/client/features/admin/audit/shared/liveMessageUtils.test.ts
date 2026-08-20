import { describe, expect, it } from 'vitest';

import {
  isNearBottom,
  isRedactionProfileTightening,
  LIVE_SCROLL_BOTTOM_THRESHOLD_PX,
  mergeMessagePages,
  pickMostRestrictiveRedactionProfile,
  relativeTimeMs,
  resolveLiveBodyAccess,
  sortMessagesChronological,
  stripMessageBodies,
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

  it('strips retained bodies after access revocation without dropping rows', () => {
    const stripped = stripMessageBodies([
      { content: 'secret body', createdAt: '2026-01-01T00:00:00.000Z', id: 'a' },
      { content: null, createdAt: '2026-01-02T00:00:00.000Z', id: 'b' },
    ]);
    expect(stripped).toEqual([
      { content: null, createdAt: '2026-01-01T00:00:00.000Z', id: 'a' },
      { content: null, createdAt: '2026-01-02T00:00:00.000Z', id: 'b' },
    ]);
  });

  it('resolveLiveBodyAccess: policy/permission loss requires purge and stops serving', () => {
    const authorized = resolveLiveBodyAccess({
      canConversationRead: true,
      contentAccessMode: 'content_allowed',
    });
    expect(authorized).toMatchObject({
      bodyHidden: false,
      includeBody: true,
      mustPurgeCachedBodies: false,
      stopServing: false,
    });

    // Policy flipped to metadata_only on the next poll while permission remains.
    const afterPolicy = resolveLiveBodyAccess({
      canConversationRead: true,
      contentAccessMode: 'metadata_only',
    });
    expect(afterPolicy).toMatchObject({
      bodyHidden: true,
      includeBody: false,
      mustPurgeCachedBodies: true,
      stopServing: false,
    });

    // Permission revoked mid-stream while policy still content_allowed.
    const afterPermission = resolveLiveBodyAccess({
      canConversationRead: false,
      contentAccessMode: 'content_allowed',
    });
    expect(afterPermission).toMatchObject({
      bodyHidden: true,
      includeBody: false,
      mustPurgeCachedBodies: true,
      stopServing: true,
    });

    // LivePage purges via stripMessageBodies when mustPurgeCachedBodies flips.
    const purged = stripMessageBodies([
      { content: 'secret-1', createdAt: '2026-01-01T00:00:00.000Z', id: 'm1' },
      { content: 'secret-2', createdAt: '2026-01-01T00:01:00.000Z', id: 'm2' },
    ]);
    expect(purged.every((m) => m.content == null)).toBe(true);
  });

  it('picks the most restrictive observed redaction profile and fail-closes unknown', () => {
    expect(pickMostRestrictiveRedactionProfile(['off', 'strict'])).toBe('strict');
    expect(pickMostRestrictiveRedactionProfile(['off', undefined, 'standard'])).toBe('standard');
    expect(pickMostRestrictiveRedactionProfile([undefined, null, 'off'])).toBe('off');
    expect(pickMostRestrictiveRedactionProfile(['off', 'loose'])).toBe('strict');
    expect(pickMostRestrictiveRedactionProfile([undefined, null])).toBeUndefined();
    expect(isRedactionProfileTightening('off', 'strict')).toBe(true);
    expect(isRedactionProfileTightening('off', 'standard')).toBe(true);
    expect(isRedactionProfileTightening('standard', 'strict')).toBe(true);
    expect(isRedactionProfileTightening('strict', 'off')).toBe(false);
    expect(isRedactionProfileTightening(undefined, 'strict')).toBe(true);
  });
});

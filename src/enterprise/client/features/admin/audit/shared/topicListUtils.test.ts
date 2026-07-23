import { describe, expect, it } from 'vitest';

import { idSetsDisjoint, mergeTopicPages } from './topicListUtils';

describe('topicListUtils', () => {
  it('merges head over older pages and sorts by updatedAt desc', () => {
    const head = [
      { id: 't2', updatedAt: '2026-01-03T00:00:00.000Z', title: 'new-t2' },
      { id: 't3', updatedAt: '2026-01-04T00:00:00.000Z', title: 't3' },
    ];
    const older = [
      [
        { id: 't1', updatedAt: '2026-01-01T00:00:00.000Z', title: 't1' },
        { id: 't2', updatedAt: '2026-01-02T00:00:00.000Z', title: 'old-t2' },
      ],
    ];
    const merged = mergeTopicPages(head, older);
    expect(merged.map((t) => t.id)).toEqual(['t3', 't2', 't1']);
    expect(merged.find((t) => t.id === 't2')?.title).toBe('new-t2');
  });

  it('detects disjoint id sets', () => {
    expect(idSetsDisjoint(['a', 'b'], ['c', 'd'])).toBe(true);
    expect(idSetsDisjoint(['a', 'b'], ['b', 'c'])).toBe(false);
  });
});

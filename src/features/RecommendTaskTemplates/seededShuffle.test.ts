import { describe, expect, it } from 'vitest';

import { seededShuffle } from './seededShuffle';

const isEqual = (a: number[], b: number[]) => a.every((value, index) => value === b[index]);

const items = Array.from({ length: 12 }, (_, index) => index);

describe('seededShuffle', () => {
  it('is deterministic for the same seed', () => {
    expect(seededShuffle(items, 'seed-a')).toEqual(seededShuffle(items, 'seed-a'));
  });

  it('produces a different order for a different seed', () => {
    expect(seededShuffle(items, 'seed-a')).not.toEqual(seededShuffle(items, 'seed-b'));
  });

  it('keeps every element exactly once', () => {
    const shuffled = seededShuffle(items, 'seed-a');

    expect(shuffled).toHaveLength(items.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
  });

  it('does not mutate the input', () => {
    const input = [...items];
    seededShuffle(input, 'seed-a');

    expect(input).toEqual(items);
  });

  it('handles empty and single-item lists', () => {
    expect(seededShuffle([], 'seed-a')).toEqual([]);
    expect(seededShuffle(['only'], 'seed-a')).toEqual(['only']);
  });

  it('reorders the list rather than returning the input order', () => {
    // Guards against a broken PRNG that always returns 0 and leaves the array untouched.
    const seeds = ['a', 'b', 'c', 'd', 'e'];
    expect(seeds.some((seed) => !isEqual(seededShuffle(items, seed), items))).toBe(true);
  });
});

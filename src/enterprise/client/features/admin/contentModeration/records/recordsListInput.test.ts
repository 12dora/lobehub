import { describe, expect, it } from 'vitest';

import {
  buildRecordsListInput,
  emptyRecordsFilters,
  toRangeEndExclusive,
  toRangeStart,
} from './RecordsTab';

describe('buildRecordsListInput', () => {
  it('sends the first page with no filter keys at all by default', () => {
    expect(buildRecordsListInput(emptyRecordsFilters(), 1, 20)).toEqual({
      actions: undefined,
      categories: undefined,
      from: undefined,
      includeNonHits: undefined,
      limit: 20,
      offset: 0,
      requestKinds: undefined,
      search: undefined,
      sources: undefined,
      to: undefined,
      userId: undefined,
      userQuery: undefined,
    });
  });

  it('maps header filters, search and the allowed-records toggle onto the list input', () => {
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-17T00:00:00.000Z');
    const input = buildRecordsListInput(
      {
        ...emptyRecordsFilters(),
        actions: ['block', 'downgrade'],
        categories: ['sexual'],
        from,
        includeNonHits: true,
        requestKinds: ['chat'],
        search: 'leak',
        sources: ['keyword'],
        to,
        userQuery: 'alice@example.com',
      },
      3,
      50,
      'user-1',
    );

    expect(input).toEqual({
      actions: ['block', 'downgrade'],
      categories: ['sexual'],
      from,
      includeNonHits: true,
      limit: 50,
      offset: 100,
      requestKinds: ['chat'],
      search: 'leak',
      sources: ['keyword'],
      to,
      userId: 'user-1',
      userQuery: 'alice@example.com',
    });
  });

  it('never sends includeNonHits:false — an absent flag is the "hits only" default', () => {
    const input = buildRecordsListInput({ ...emptyRecordsFilters(), includeNonHits: false }, 1, 20);
    expect(input.includeNonHits).toBeUndefined();
  });
});

describe('date range normalization', () => {
  it('sends a half-open window so the picked end day is included', () => {
    // The picker hands back local midnight for both ends; the server filters `createdAt < to`.
    const picked = new Date(2026, 7, 2, 0, 0, 0);
    const to = toRangeEndExclusive(picked)!;
    expect(to.getFullYear()).toBe(2026);
    expect(to.getMonth()).toBe(7);
    expect(to.getDate()).toBe(3);
    expect(to.getHours()).toBe(0);
    // A record written late on 8/2 must fall inside the window.
    expect(new Date(2026, 7, 2, 23, 59, 59).getTime()).toBeLessThan(to.getTime());
  });

  it('snaps the start to local midnight of the picked day', () => {
    const from = toRangeStart(new Date(2026, 7, 1, 13, 45))!;
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(from.getDate()).toBe(1);
  });

  it('passes nullish bounds through untouched', () => {
    expect(toRangeStart(null)).toBeUndefined();
    expect(toRangeEndExclusive(undefined)).toBeUndefined();
  });
});

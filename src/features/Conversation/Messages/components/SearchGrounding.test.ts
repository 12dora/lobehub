import { describe, expect, it } from 'vitest';

import { resolveSearchGroundingHeadline } from './SearchGrounding';

describe('resolveSearchGroundingHeadline', () => {
  it('uses Searching… only while a query-only search is in flight', () => {
    expect(
      resolveSearchGroundingHeadline({
        hasImageResults: false,
        hasWebResults: false,
        searching: true,
      }),
    ).toBe('searching');
  });

  it('uses a completed zero-result headline after a query-only search finishes', () => {
    expect(
      resolveSearchGroundingHeadline({
        hasImageResults: false,
        hasWebResults: false,
        searching: false,
      }),
    ).toBe('noResults');
  });

  it('prefers citation and image counts over the searching state', () => {
    expect(
      resolveSearchGroundingHeadline({
        hasImageResults: false,
        hasWebResults: true,
        searching: true,
      }),
    ).toBe('title');
    expect(
      resolveSearchGroundingHeadline({
        hasImageResults: true,
        hasWebResults: false,
        searching: false,
      }),
    ).toBe('imageTitle');
  });
});

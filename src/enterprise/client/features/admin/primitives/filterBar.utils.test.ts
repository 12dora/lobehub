import { describe, expect, it } from 'vitest';

import {
  clearAdminFilters,
  createEmptyAdminFilters,
  hasActiveAdminFilters,
} from './filterBar.utils';

describe('filterBar.utils', () => {
  it('tracks active filters and clears them', () => {
    const empty = createEmptyAdminFilters(['status']);
    expect(hasActiveAdminFilters(empty)).toBe(false);

    const active = { ...empty, query: 'alice', status: 'draft' };
    expect(hasActiveAdminFilters(active)).toBe(true);
    expect(hasActiveAdminFilters(clearAdminFilters(active))).toBe(false);
  });
});

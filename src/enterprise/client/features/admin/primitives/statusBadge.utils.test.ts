import { describe, expect, it } from 'vitest';

import { getAdminStatusPresentation, normalizeAdminStatus } from './statusBadge.utils';

describe('statusBadge.utils', () => {
  it('normalizes known statuses case-insensitively', () => {
    expect(normalizeAdminStatus('Draft')).toBe('draft');
    expect(normalizeAdminStatus('PUBLISHED')).toBe('published');
    expect(normalizeAdminStatus('weird')).toBe('unknown');
    expect(normalizeAdminStatus(null)).toBe('unknown');
  });

  it('maps semantic colors and labels without hard-coded hex', () => {
    const draft = getAdminStatusPresentation('draft');
    expect(draft.color).toBe('warning');
    expect(draft.labelKey).toBe('primitives.status.draft');

    const published = getAdminStatusPresentation('published');
    expect(published.color).toBe('success');
    expect(published.icon).toBe('check');
  });
});

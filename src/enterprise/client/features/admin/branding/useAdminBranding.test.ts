import { describe, expect, it } from 'vitest';

import { shouldFetchAdminBranding } from './useAdminBranding';

describe('shouldFetchAdminBranding', () => {
  it.each([
    { adminAllowed: false, brandingEnabled: true, canRead: true },
    { adminAllowed: true, brandingEnabled: false, canRead: true },
    { adminAllowed: true, brandingEnabled: true, canRead: false },
  ])('returns false and therefore mounts zero fetches for denied gate %j', (input) => {
    expect(shouldFetchAdminBranding(input)).toBe(false);
  });

  it('fetches only after every server-derived gate is allowed', () => {
    expect(
      shouldFetchAdminBranding({ adminAllowed: true, brandingEnabled: true, canRead: true }),
    ).toBe(true);
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { shouldFetchAdminSettingsDraft } from './useAdminSettings';

describe('shouldFetchAdminSettingsDraft (U1)', () => {
  it('issues zero fetch when M05 policy flag capability is off', () => {
    expect(shouldFetchAdminSettingsDraft({ enabled: true, userSettingsPolicyEnabled: false })).toBe(
      false,
    );
  });

  it('fetches only when both page enabled and capability on', () => {
    expect(shouldFetchAdminSettingsDraft({ enabled: true, userSettingsPolicyEnabled: true })).toBe(
      true,
    );
    expect(shouldFetchAdminSettingsDraft({ enabled: false, userSettingsPolicyEnabled: true })).toBe(
      false,
    );
  });
});

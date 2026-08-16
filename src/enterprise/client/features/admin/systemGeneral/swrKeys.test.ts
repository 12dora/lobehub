import { describe, expect, it } from 'vitest';

import { ADMIN_SYSTEM_INFRA_SETTINGS_KEY, buildAdminInfraSettingsKey } from './swrKeys';

describe('admin infra settings SWR keys', () => {
  it('returns null when SYSTEM_READ is unavailable', () => {
    expect(buildAdminInfraSettingsKey(false)).toBeNull();
  });

  it('returns a stable key when the page is allowed', () => {
    expect(buildAdminInfraSettingsKey(true)).toEqual([ADMIN_SYSTEM_INFRA_SETTINGS_KEY]);
  });
});

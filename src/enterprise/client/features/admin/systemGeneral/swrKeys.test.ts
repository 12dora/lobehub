import { describe, expect, it } from 'vitest';

import {
  ADMIN_BROWSER_PROFILE_KEY,
  ADMIN_SYSTEM_INFRA_SETTINGS_KEY,
  ADMIN_SYSTEM_SANDBOX_SETTINGS_KEY,
  buildAdminBrowserProfileKey,
  buildAdminInfraSettingsKey,
  buildAdminSandboxSettingsKey,
} from './swrKeys';

describe('admin infra settings SWR keys', () => {
  it('returns null when SYSTEM_READ is unavailable', () => {
    expect(buildAdminInfraSettingsKey(false)).toBeNull();
  });

  it('returns a stable key when the page is allowed', () => {
    expect(buildAdminInfraSettingsKey(true)).toEqual([ADMIN_SYSTEM_INFRA_SETTINGS_KEY]);
    expect(buildAdminBrowserProfileKey(true)).toEqual([ADMIN_BROWSER_PROFILE_KEY]);
    expect(buildAdminBrowserProfileKey(false)).toBeNull();
    expect(buildAdminSandboxSettingsKey(true)).toEqual([ADMIN_SYSTEM_SANDBOX_SETTINGS_KEY]);
    expect(buildAdminSandboxSettingsKey(false)).toBeNull();
  });
});

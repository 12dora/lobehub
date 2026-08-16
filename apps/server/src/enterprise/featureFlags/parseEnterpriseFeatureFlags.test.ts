// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  getDefaultEnterpriseFeatureFlags,
  isAnyEnterpriseFeatureEnabled,
  isPlatformAdminFeatureEnabled,
  parseEnterpriseFeatureFlags,
} from './parseEnterpriseFeatureFlags';

describe('parseEnterpriseFeatureFlags', () => {
  it('defaults every flag to true when env is empty', () => {
    const flags = parseEnterpriseFeatureFlags({});
    expect(flags).toEqual(getDefaultEnterpriseFeatureFlags());
    expect(Object.values(flags).every((v) => v === true)).toBe(true);
  });

  it('accepts ENABLE_ENTERPRISE_ADMIN as alias for platform admin', () => {
    expect(
      parseEnterpriseFeatureFlags({ ENABLE_ENTERPRISE_ADMIN: '0' }).ENABLE_PLATFORM_ADMIN,
    ).toBe(false);
    expect(
      parseEnterpriseFeatureFlags({ ENABLE_PLATFORM_ADMIN: 'false' }).ENABLE_PLATFORM_ADMIN,
    ).toBe(false);
    expect(
      parseEnterpriseFeatureFlags({ ENABLE_ENTERPRISE_ADMIN: '1' }).ENABLE_PLATFORM_ADMIN,
    ).toBe(true);
  });

  it('disables only the flags that are explicitly turned off', () => {
    const flags = parseEnterpriseFeatureFlags({ ENABLE_PLATFORM_MANAGED_AI: '0' });
    expect(flags.ENABLE_PLATFORM_MANAGED_AI).toBe(false);
    expect(flags.ENABLE_PLATFORM_ADMIN).toBe(true);
    expect(flags.ENABLE_RUNTIME_BRANDING).toBe(true);
  });

  it('accepts every documented falsy spelling, case-insensitively', () => {
    for (const raw of ['0', 'false', 'FALSE', 'no', ' Off ']) {
      expect(
        parseEnterpriseFeatureFlags({ ENABLE_RUNTIME_BRANDING: raw }).ENABLE_RUNTIME_BRANDING,
      ).toBe(false);
    }
    for (const raw of ['1', 'true', 'YES', ' on ']) {
      expect(
        parseEnterpriseFeatureFlags({ ENABLE_RUNTIME_BRANDING: raw }).ENABLE_RUNTIME_BRANDING,
      ).toBe(true);
    }
  });

  it('turns everything off only when every flag is explicitly disabled', () => {
    const flags = parseEnterpriseFeatureFlags({
      ENABLE_DATABASE_OIDC: '0',
      ENABLE_PLATFORM_ADMIN: '0',
      ENABLE_PLATFORM_MANAGED_AGENTS: '0',
      ENABLE_PLATFORM_MANAGED_AI: '0',
      ENABLE_PLATFORM_MANAGED_CONNECTORS: '0',
      ENABLE_PLATFORM_MANAGED_SKILLS: '0',
      ENABLE_PLATFORM_SETTINGS_POLICY: '0',
      ENABLE_RUNTIME_BRANDING: '0',
    });

    expect(Object.values(flags).every((v) => v === false)).toBe(true);
    expect(isAnyEnterpriseFeatureEnabled(flags)).toBe(false);
    expect(isPlatformAdminFeatureEnabled(flags)).toBe(false);
  });

  it('reports the platform surface as live on an unconfigured environment', () => {
    const flags = parseEnterpriseFeatureFlags({});
    expect(isAnyEnterpriseFeatureEnabled(flags)).toBe(true);
    expect(isPlatformAdminFeatureEnabled(flags)).toBe(true);
  });
});

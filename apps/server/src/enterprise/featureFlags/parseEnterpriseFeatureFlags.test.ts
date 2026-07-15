// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  getDefaultEnterpriseFeatureFlags,
  parseEnterpriseFeatureFlags,
} from './parseEnterpriseFeatureFlags';

describe('parseEnterpriseFeatureFlags', () => {
  it('defaults every flag to false when env is empty', () => {
    const flags = parseEnterpriseFeatureFlags({});
    expect(flags).toEqual(getDefaultEnterpriseFeatureFlags());
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });

  it('accepts ENABLE_ENTERPRISE_ADMIN as alias for platform admin', () => {
    expect(
      parseEnterpriseFeatureFlags({ ENABLE_ENTERPRISE_ADMIN: '1' }).ENABLE_PLATFORM_ADMIN,
    ).toBe(true);
    expect(
      parseEnterpriseFeatureFlags({ ENABLE_PLATFORM_ADMIN: 'true' }).ENABLE_PLATFORM_ADMIN,
    ).toBe(true);
  });

  it('does not enable managed AI without its own flag', () => {
    const flags = parseEnterpriseFeatureFlags({ ENABLE_PLATFORM_ADMIN: '1' });
    expect(flags.ENABLE_PLATFORM_ADMIN).toBe(true);
    expect(flags.ENABLE_PLATFORM_MANAGED_AI).toBe(false);
    expect(flags.ENABLE_RUNTIME_BRANDING).toBe(false);
  });

  it('parses managed and branding flags independently', () => {
    const flags = parseEnterpriseFeatureFlags({
      ENABLE_PLATFORM_MANAGED_AI: 'yes',
      ENABLE_PLATFORM_MANAGED_SKILLS: 'on',
      ENABLE_RUNTIME_BRANDING: '1',
    });
    expect(flags.ENABLE_PLATFORM_MANAGED_AI).toBe(true);
    expect(flags.ENABLE_PLATFORM_MANAGED_SKILLS).toBe(true);
    expect(flags.ENABLE_RUNTIME_BRANDING).toBe(true);
    expect(flags.ENABLE_PLATFORM_ADMIN).toBe(false);
  });
});

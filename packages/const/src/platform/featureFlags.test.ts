import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENTERPRISE_FEATURE_FLAGS,
  ENTERPRISE_FEATURE_FLAG_KEYS,
  isEnterpriseFlagTruthy,
} from './featureFlags';

describe('enterprise feature flags', () => {
  it('defaults every flag to false', () => {
    for (const value of Object.values(DEFAULT_ENTERPRISE_FEATURE_FLAGS)) {
      expect(value).toBe(false);
    }
  });

  it('lists known env keys including the M00 admin alias', () => {
    expect(ENTERPRISE_FEATURE_FLAG_KEYS).toContain('ENABLE_PLATFORM_ADMIN');
    expect(ENTERPRISE_FEATURE_FLAG_KEYS).toContain('ENABLE_ENTERPRISE_ADMIN');
    expect(ENTERPRISE_FEATURE_FLAG_KEYS).toContain('ENABLE_RUNTIME_BRANDING');
  });

  it('parses truthy env values case-insensitively', () => {
    expect(isEnterpriseFlagTruthy('1')).toBe(true);
    expect(isEnterpriseFlagTruthy('true')).toBe(true);
    expect(isEnterpriseFlagTruthy('YES')).toBe(true);
    expect(isEnterpriseFlagTruthy(' on ')).toBe(true);
    expect(isEnterpriseFlagTruthy('0')).toBe(false);
    expect(isEnterpriseFlagTruthy('false')).toBe(false);
    expect(isEnterpriseFlagTruthy(undefined)).toBe(false);
    expect(isEnterpriseFlagTruthy('')).toBe(false);
  });
});

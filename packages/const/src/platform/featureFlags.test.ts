import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENTERPRISE_FEATURE_FLAGS,
  DISABLED_ENTERPRISE_FEATURE_FLAGS,
  ENTERPRISE_FEATURE_FLAG_KEYS,
  isEnterpriseFlagEnabled,
  isEnterpriseFlagFalsy,
  isEnterpriseFlagTruthy,
  isPlatformAdminFlagEnabled,
} from './featureFlags';

describe('enterprise feature flags', () => {
  it('defaults every flag to true', () => {
    for (const value of Object.values(DEFAULT_ENTERPRISE_FEATURE_FLAGS)) {
      expect(value).toBe(true);
    }
  });

  it('exposes an all-closed baseline for upstream-parity callers', () => {
    for (const value of Object.values(DISABLED_ENTERPRISE_FEATURE_FLAGS)) {
      expect(value).toBe(false);
    }
    expect(Object.keys(DISABLED_ENTERPRISE_FEATURE_FLAGS).sort()).toEqual(
      Object.keys(DEFAULT_ENTERPRISE_FEATURE_FLAGS).sort(),
    );
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

  it('parses falsy env values case-insensitively', () => {
    expect(isEnterpriseFlagFalsy('0')).toBe(true);
    expect(isEnterpriseFlagFalsy('false')).toBe(true);
    expect(isEnterpriseFlagFalsy('NO')).toBe(true);
    expect(isEnterpriseFlagFalsy(' Off ')).toBe(true);
    expect(isEnterpriseFlagFalsy('1')).toBe(false);
    expect(isEnterpriseFlagFalsy(undefined)).toBe(false);
    expect(isEnterpriseFlagFalsy('')).toBe(false);
  });

  it('keeps a flag enabled unless it is explicitly disabled', () => {
    expect(isEnterpriseFlagEnabled(undefined)).toBe(true);
    expect(isEnterpriseFlagEnabled('')).toBe(true);
    expect(isEnterpriseFlagEnabled('   ')).toBe(true);
    expect(isEnterpriseFlagEnabled('1')).toBe(true);
    expect(isEnterpriseFlagEnabled('on')).toBe(true);
    // Unrecognised values keep the default rather than silently closing a feature.
    expect(isEnterpriseFlagEnabled('maybe')).toBe(true);

    expect(isEnterpriseFlagEnabled('0')).toBe(false);
    expect(isEnterpriseFlagEnabled('false')).toBe(false);
    expect(isEnterpriseFlagEnabled('NO')).toBe(false);
    expect(isEnterpriseFlagEnabled(' off ')).toBe(false);
  });

  describe('isPlatformAdminFlagEnabled', () => {
    it('is enabled on an unconfigured environment', () => {
      expect(isPlatformAdminFlagEnabled({})).toBe(true);
    });

    it('honours an explicit disable on either key', () => {
      expect(isPlatformAdminFlagEnabled({ ENABLE_PLATFORM_ADMIN: '0' })).toBe(false);
      expect(isPlatformAdminFlagEnabled({ ENABLE_ENTERPRISE_ADMIN: 'false' })).toBe(false);
    });

    it('honours an explicit enable on either key', () => {
      expect(isPlatformAdminFlagEnabled({ ENABLE_PLATFORM_ADMIN: '1' })).toBe(true);
      expect(isPlatformAdminFlagEnabled({ ENABLE_ENTERPRISE_ADMIN: 'yes' })).toBe(true);
    });

    it('lets an explicit enable on the alias win over a disable on the canonical key', () => {
      expect(
        isPlatformAdminFlagEnabled({
          ENABLE_ENTERPRISE_ADMIN: '1',
          ENABLE_PLATFORM_ADMIN: '0',
        }),
      ).toBe(true);
    });
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';

import {
  buildPlatformPublicSnapshot,
  getDisabledPlatformPublicSnapshot,
} from './platformPublicSnapshot';

describe('buildPlatformPublicSnapshot', () => {
  it('returns disabled public snapshot when flags are off', () => {
    const snap = buildPlatformPublicSnapshot({ flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS } });
    expect(snap).toEqual(getDisabledPlatformPublicSnapshot());
  });

  it('hides branding fields when runtime branding flag is off', () => {
    const snap = buildPlatformPublicSnapshot({
      branding: { logoUrl: '/x.png', platformName: 'AIHub', revision: '9' },
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS },
    });
    expect(snap.platformName).toBeNull();
    expect(snap.logoUrl).toBeNull();
    expect(snap.brandingRevision).toBeNull();
  });

  it('surfaces branding only when ENABLE_RUNTIME_BRANDING is on', () => {
    const snap = buildPlatformPublicSnapshot({
      branding: { logoUrl: '/logo.png', platformName: 'AIHub', revision: '2' },
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
    });
    expect(snap.platformName).toBe('AIHub');
    expect(snap.logoUrl).toBe('/logo.png');
    expect(snap.brandingRevision).toBe('2');
  });

  it('enables work account only when OIDC flag and published IdP are both true', () => {
    expect(
      buildPlatformPublicSnapshot({
        flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_DATABASE_OIDC: true },
        workAccountEnabled: false,
      }).login.workAccountEnabled,
    ).toBe(false);

    expect(
      buildPlatformPublicSnapshot({
        flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_DATABASE_OIDC: true },
        workAccountEnabled: true,
      }).login.workAccountEnabled,
    ).toBe(true);
  });

  it('does not leak secrets or admin fields', () => {
    const snap = buildPlatformPublicSnapshot({
      branding: { logoUrl: '/a.png', platformName: 'AIHub', revision: '1' },
      flags: {
        ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
        ENABLE_DATABASE_OIDC: true,
        ENABLE_RUNTIME_BRANDING: true,
      },
      workAccountEnabled: true,
    });
    expect(snap).not.toHaveProperty('clientSecret');
    expect(snap).not.toHaveProperty('adminAccess');
    expect(snap).not.toHaveProperty('roles');
    expect(JSON.stringify(snap)).not.toMatch(/secret|token|password/i);
  });
});

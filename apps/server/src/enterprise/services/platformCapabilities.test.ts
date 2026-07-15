// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';

import {
  buildPlatformCapabilities,
  findForbiddenCapabilityKeys,
  getDisabledPlatformCapabilities,
} from './platformCapabilities';

describe('buildPlatformCapabilities', () => {
  it('returns fully disabled snapshot when flags are default-off', () => {
    const caps = buildPlatformCapabilities({ flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS } });
    expect(caps).toEqual(getDisabledPlatformCapabilities());
    expect(caps.adminAccess).toBe(false);
    expect(Object.values(caps.managedResources).every((v) => !v)).toBe(true);
  });

  it('exposes feature toggles without granting adminAccess without RBAC', () => {
    const caps = buildPlatformCapabilities({
      flags: {
        ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
        ENABLE_PLATFORM_ADMIN: true,
        ENABLE_PLATFORM_MANAGED_AI: true,
      },
    });
    expect(caps.features.platformAdmin).toBe(true);
    expect(caps.managedResources.aiProviders).toBe(true);
    expect(caps.managedResources.aiModels).toBe(true);
    // M00: no RBAC yet — adminAccess stays false unless explicitly granted
    expect(caps.adminAccess).toBe(false);
  });

  it('sets adminAccess only when flag on and caller marks access', () => {
    const denied = buildPlatformCapabilities({
      adminAccess: true,
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS },
    });
    expect(denied.adminAccess).toBe(false);

    const allowed = buildPlatformCapabilities({
      adminAccess: true,
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_ADMIN: true },
    });
    expect(allowed.adminAccess).toBe(true);
  });

  it('never includes forbidden keys (roles, secrets, permissions)', () => {
    const caps = buildPlatformCapabilities({
      adminAccess: true,
      flags: {
        ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
        ENABLE_PLATFORM_ADMIN: true,
        ENABLE_PLATFORM_MANAGED_AGENTS: true,
        ENABLE_RUNTIME_BRANDING: true,
      },
      revisions: { brandingRevision: '3', configRevision: '3', settingsRevision: '2' },
    });
    expect(findForbiddenCapabilityKeys(caps)).toEqual([]);
    expect(caps).not.toHaveProperty('roles');
    expect(caps).not.toHaveProperty('permissions');
    expect(JSON.stringify(caps)).not.toMatch(/secret|token|password|apiKey/i);
  });
});

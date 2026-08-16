// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';

import { findForbiddenCapabilityKeys } from './__test-support__/capabilityTestHelpers';
import { buildPlatformCapabilities } from './platformCapabilities';

describe('buildPlatformCapabilities', () => {
  it('returns fully disabled snapshot when flags are default-off', () => {
    const caps = buildPlatformCapabilities({ flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS } });
    expect(caps).toEqual({
      ...DISABLED_PLATFORM_CAPABILITIES,
      features: { ...DISABLED_PLATFORM_CAPABILITIES.features },
      managedResources: { ...DISABLED_PLATFORM_CAPABILITIES.managedResources },
    });
    expect(caps.adminAccess).toBe(false);
    expect(Object.values(caps.managedResources).every((v) => !v)).toBe(true);
  });

  it('does not infer managed resources from rollout flags alone', () => {
    const caps = buildPlatformCapabilities({
      flags: {
        ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
        ENABLE_PLATFORM_ADMIN: true,
        ENABLE_PLATFORM_MANAGED_AI: true,
      },
    });
    expect(caps.features.platformAdmin).toBe(true);
    expect(caps.managedResources.aiProviders).toBe(false);
    expect(caps.managedResources.aiModels).toBe(false);
    // adminAccess requires explicit permission-derived grant, not the flag alone
    expect(caps.adminAccess).toBe(false);
  });

  it('accepts only already-resolved published policy booleans', () => {
    const caps = buildPlatformCapabilities({
      flags: {
        ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
        ENABLE_PLATFORM_MANAGED_AI: true,
      },
      managedResources: {
        agents: false,
        aiModels: true,
        aiProviders: true,
        connectors: false,
        skills: false,
      },
    });
    expect(caps.managedResources.aiProviders).toBe(true);
    expect(caps).not.toHaveProperty('enforcementMode');
  });

  it('exposes aiTakeover only with the managed-AI flag and a resolved server verdict', () => {
    const flagOff = buildPlatformCapabilities({
      aiTakeover: true,
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS },
    });
    expect(flagOff.aiTakeover).toBe(false);

    const flagOn = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true };
    expect(buildPlatformCapabilities({ flags: flagOn }).aiTakeover).toBe(false);
    expect(buildPlatformCapabilities({ aiTakeover: true, flags: flagOn }).aiTakeover).toBe(true);

    // `ui-only` blocks the UI without a runtime takeover: the two signals must be independent.
    const uiOnly = buildPlatformCapabilities({
      aiTakeover: false,
      flags: flagOn,
      managedResources: {
        agents: false,
        aiModels: true,
        aiProviders: true,
        connectors: false,
        skills: false,
      },
    });
    expect(uiOnly.managedResources.aiProviders).toBe(true);
    expect(uiOnly.aiTakeover).toBe(false);
  });

  it('sets adminAccess only when flag on and caller marks access', () => {
    const denied = buildPlatformCapabilities({
      adminAccess: true,
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS },
    });
    expect(denied.adminAccess).toBe(false);

    const allowed = buildPlatformCapabilities({
      adminAccess: true,
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_ADMIN: true },
    });
    expect(allowed.adminAccess).toBe(true);
  });

  it('never includes forbidden keys (roles, secrets, permissions)', () => {
    const caps = buildPlatformCapabilities({
      adminAccess: true,
      flags: {
        ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
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

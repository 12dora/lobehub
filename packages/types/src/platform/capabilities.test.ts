import { describe, expect, it } from 'vitest';

import {
  DISABLED_PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITIES_FORBIDDEN_KEYS,
  type PlatformCapabilities,
} from './capabilities';

const collectKeys = (value: unknown, prefix = ''): string[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      return [path, ...collectKeys(child, path)];
    }
    return [path];
  });
};

describe('PlatformCapabilities', () => {
  it('disabled snapshot has no admin access and no managed resources', () => {
    expect(DISABLED_PLATFORM_CAPABILITIES.adminAccess).toBe(false);
    expect(DISABLED_PLATFORM_CAPABILITIES.userSettingsPolicyEnabled).toBe(false);
    expect(DISABLED_PLATFORM_CAPABILITIES.configRevision).toBe('0');
    expect(Object.values(DISABLED_PLATFORM_CAPABILITIES.managedResources).every((v) => !v)).toBe(
      true,
    );
    expect(Object.values(DISABLED_PLATFORM_CAPABILITIES.features).every((v) => !v)).toBe(true);
  });

  it('does not expose role lists, secrets, or permission arrays on the disabled snapshot', () => {
    const keys = collectKeys(DISABLED_PLATFORM_CAPABILITIES).map((k) => k.toLowerCase());
    for (const forbidden of PLATFORM_CAPABILITIES_FORBIDDEN_KEYS) {
      expect(keys.some((k) => k === forbidden || k.endsWith(`.${forbidden}`))).toBe(false);
    }
    expect(DISABLED_PLATFORM_CAPABILITIES).not.toHaveProperty('roles');
    expect(DISABLED_PLATFORM_CAPABILITIES).not.toHaveProperty('permissions');
  });

  it('keeps public shape assignable without role/secret fields', () => {
    const sample: PlatformCapabilities = {
      ...DISABLED_PLATFORM_CAPABILITIES,
      adminAccess: false,
      features: { ...DISABLED_PLATFORM_CAPABILITIES.features, platformAdmin: true },
    };
    expect(sample.features.platformAdmin).toBe(true);
    expect(sample).not.toHaveProperty('roles');
  });
});

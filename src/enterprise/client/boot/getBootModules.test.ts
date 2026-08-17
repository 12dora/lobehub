import { afterEach, describe, expect, it } from 'vitest';

import { ALL_MODULES_ENABLED } from '@/const/platform/modules';

import { getBootDisabledModules, getBootModules, normalizeModuleStateMap } from './getBootModules';

const setBoot = (modules: unknown) => {
  window.__SERVER_CONFIG__ = {
    analyticsConfig: {},
    clientEnv: {},
    config: { enterprise: { enabled: true, modules } },
    featureFlags: {},
    isMobile: false,
  } as never;
};

describe('getBootModules', () => {
  afterEach(() => {
    window.__SERVER_CONFIG__ = undefined;
  });

  it('fails OPEN when there is no server config at all (vite dev)', () => {
    window.__SERVER_CONFIG__ = undefined;
    expect(getBootModules()).toEqual(ALL_MODULES_ENABLED);
    expect(getBootDisabledModules().size).toBe(0);
  });

  it('fails open when the enterprise block carries no module map', () => {
    setBoot(undefined);
    expect(getBootModules()).toEqual(ALL_MODULES_ENABLED);
  });

  it('reads an explicit disable', () => {
    setBoot({ ...ALL_MODULES_ENABLED, audit: false });
    expect(getBootModules().audit).toBe(false);
    expect(getBootModules().moderation).toBe(true);
    expect([...getBootDisabledModules()]).toEqual(['audit']);
  });

  it('treats a partial payload as "the rest are on", never as "the rest are off"', () => {
    setBoot({ audit: false });
    const state = getBootModules();
    expect(state.audit).toBe(false);
    expect(state.moderation).toBe(true);
    expect(state.networkProxy).toBe(true);
  });

  it('ignores non-boolean and unknown entries', () => {
    expect(normalizeModuleStateMap({ audit: 'no', bogusModule: false })).toEqual(
      ALL_MODULES_ENABLED,
    );
  });

  it('normalizes a non-object payload to everything enabled', () => {
    expect(normalizeModuleStateMap('nope')).toEqual(ALL_MODULES_ENABLED);
    expect(normalizeModuleStateMap(null)).toEqual(ALL_MODULES_ENABLED);
  });
});

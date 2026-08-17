import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALL_MODULES_ENABLED } from '@/const/platform/modules';
import {
  DISABLED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '@/types/platform/capabilities';

import { useDisabledModules, useModuleEnabled, useModuleStates } from './useModuleEnabled';

const platform = {
  capabilities: DISABLED_PLATFORM_CAPABILITIES as PlatformCapabilities,
  error: null as Error | null,
  loading: false,
};

vi.mock('../providers/enterprisePlatformContext', () => ({
  useEnterprisePlatform: () => ({ ...platform, publicSnapshot: {}, refresh: async () => {} }),
}));

/** A live payload is always a fresh object — never the shared disabled sentinel. */
const resolvedCapabilities = (modules: Record<string, boolean>): PlatformCapabilities =>
  ({
    ...DISABLED_PLATFORM_CAPABILITIES,
    modules: { ...ALL_MODULES_ENABLED, ...modules },
  }) as PlatformCapabilities;

const setBootModules = (modules: Record<string, boolean> | undefined) => {
  window.__SERVER_CONFIG__ = {
    analyticsConfig: {},
    clientEnv: {},
    config: { enterprise: { enabled: true, modules } },
    featureFlags: {},
    isMobile: false,
  } as never;
};

afterEach(() => {
  window.__SERVER_CONFIG__ = undefined;
  platform.capabilities = DISABLED_PLATFORM_CAPABILITIES;
  platform.error = null;
  platform.loading = false;
});

describe('useModuleStates', () => {
  it('uses the boot payload while the capability fetch is still pending', () => {
    // The provider hands out DISABLED_PLATFORM_CAPABILITIES (modules = all on) until the first
    // response lands. Reading that as an answer would flash every disabled module back on.
    setBootModules({ audit: false });
    platform.loading = true;

    const { result } = renderHook(() => useModuleStates());
    expect(result.current.audit).toBe(false);
    expect(result.current.moderation).toBe(true);
  });

  it('keeps boot-disabled modules disabled after the capability fetch fails', () => {
    setBootModules({ audit: false, networkProxy: false });
    platform.error = new Error('capabilities offline');

    const { result } = renderHook(() => useDisabledModules());
    expect([...result.current].sort()).toEqual(['audit', 'networkProxy']);
  });

  it('falls back to boot outside a provider tree', () => {
    setBootModules({ branding: false });
    const { result } = renderHook(() => useModuleEnabled('branding'));
    expect(result.current).toBe(false);
  });

  it('prefers a resolved capability payload over the boot payload', () => {
    // A hot module re-enabled by an admin must appear without a page reload, even though the
    // boot payload (fixed at page load) still says it is off.
    setBootModules({ branding: false });
    platform.capabilities = resolvedCapabilities({ branding: true, taskTemplates: false });

    const { result } = renderHook(() => useModuleStates());
    expect(result.current.branding).toBe(true);
    expect(result.current.taskTemplates).toBe(false);
  });

  it('fails open when neither source says anything', () => {
    const { result } = renderHook(() => useModuleStates());
    expect(result.current).toEqual(ALL_MODULES_ENABLED);
  });
});

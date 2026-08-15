/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';
import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import { useManagedResource, usePlatformAiTakeover } from './useManagedResource';

const platform = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock('@/enterprise/client/providers/EnterprisePlatformProvider', () => ({
  useEnterprisePlatform: () => platform.value,
}));

const withCapabilities = (overrides: {
  aiProviders?: boolean;
  aiTakeover?: boolean;
  error?: Error | null;
  loading?: boolean;
}) => {
  platform.value = {
    publicSnapshot: DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
    refresh: async () => {},
    capabilities: {
      ...DISABLED_PLATFORM_CAPABILITIES,
      aiTakeover: overrides.aiTakeover ?? false,
      managedResources: {
        ...DISABLED_PLATFORM_CAPABILITIES.managedResources,
        aiProviders: overrides.aiProviders ?? false,
      },
    },
    error: overrides.error ?? null,
    loading: overrides.loading ?? false,
  };
};

describe('usePlatformAiTakeover', () => {
  it('is true only when the server reports a runtime takeover', () => {
    withCapabilities({ aiProviders: true, aiTakeover: true });
    expect(renderHook(() => usePlatformAiTakeover()).result.current.takeover).toBe(true);

    withCapabilities({ aiProviders: false, aiTakeover: false });
    expect(renderHook(() => usePlatformAiTakeover()).result.current.takeover).toBe(false);
  });

  it('separates "UI blocked" from "runtime taken over" for the ui-only policy', () => {
    // `ui-only` blocks the settings UI but leaves every user on their own credentials, so an
    // admin hint promising "live for every member" must not fire on it.
    withCapabilities({ aiProviders: true, aiTakeover: false });

    expect(renderHook(() => useManagedResource('aiProviders')).result.current.managed).toBe(true);
    expect(renderHook(() => usePlatformAiTakeover()).result.current.takeover).toBe(false);
  });

  it('fails closed while STALE cached data still says the platform is in charge', () => {
    // SWR keeps the last successful payload alongside an error / during revalidation, so the
    // hook must not keep claiming "live for every member" after enforcement ended and the
    // capability refresh failed.
    withCapabilities({ aiProviders: true, aiTakeover: true, loading: true });
    const loadingResult = renderHook(() => usePlatformAiTakeover()).result;
    expect(loadingResult.current.takeover).toBe(false);
    expect(loadingResult.current.takeoverKnown).toBe(false);
    expect(loadingResult.current.loading).toBe(true);

    withCapabilities({ aiProviders: true, aiTakeover: true, error: new Error('offline') });
    const errorResult = renderHook(() => usePlatformAiTakeover()).result;
    expect(errorResult.current.takeover).toBe(false);
    expect(errorResult.current.takeoverKnown).toBe(false);
    expect(errorResult.current.error?.message).toBe('offline');
  });

  it('reports takeoverKnown once a fresh capability payload has resolved', () => {
    withCapabilities({ aiTakeover: true });
    const enforced = renderHook(() => usePlatformAiTakeover()).result;
    expect(enforced.current).toMatchObject({ takeover: true, takeoverKnown: true });

    withCapabilities({ aiTakeover: false });
    const unmanaged = renderHook(() => usePlatformAiTakeover()).result;
    expect(unmanaged.current).toMatchObject({ takeover: false, takeoverKnown: true });
  });
});

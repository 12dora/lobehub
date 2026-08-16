import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mutate, useClientDataSWR } from '@/libs/swr';
import {
  DISABLED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

import {
  AI_CACHE_TRANSITION_SETTLE_DELAY,
  isAiInfraPlatformSensitiveSwrKey,
  PLATFORM_CAPABILITIES_REFRESH_INTERVAL,
  PLATFORM_CAPABILITIES_SWR_KEY,
  PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
  PLATFORM_PUBLIC_SNAPSHOT_SWR_KEY,
  useEnterprisePlatformData,
} from './useEnterprisePlatformData';

vi.mock('@/libs/swr', () => ({ mutate: vi.fn(), useClientDataSWR: vi.fn() }));

const capabilitiesMutate = vi.fn();
const publicSnapshotMutate = vi.fn();

const capabilities: PlatformCapabilities = {
  ...DISABLED_PLATFORM_CAPABILITIES,
  managedResources: { ...DISABLED_PLATFORM_CAPABILITIES.managedResources, agents: true },
};
const publicSnapshot: PlatformPublicSnapshot = {
  ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  branding: {
    defaultAgentDisplayName: null,
    emailFrom: null,
    emailSenderName: null,
    faviconUrl: null,
    homeUrl: null,
    iconUrl: null,
    legalName: null,
    logoUrl: '/brand.png',
    name: 'Brand',
    ogImageUrl: null,
    pageTitleTemplate: null,
    privacyUrl: null,
    revision: '4',
    shortName: null,
    supportUrl: null,
    termsUrl: null,
  },
  brandingRevision: '4',
  logoUrl: '/brand.png',
  platformName: 'Brand',
};

const mockSWR = (options?: {
  capabilitiesError?: unknown;
  publicError?: unknown;
  useFallbackData?: boolean;
}) => {
  vi.mocked(useClientDataSWR).mockImplementation((key, _fetcher, config) => {
    const isCapabilities = key === PLATFORM_CAPABILITIES_SWR_KEY;
    return {
      data: options?.useFallbackData
        ? config?.fallbackData
        : isCapabilities
          ? capabilities
          : publicSnapshot,
      error: isCapabilities ? options?.capabilitiesError : options?.publicError,
      isLoading: false,
      mutate: isCapabilities ? capabilitiesMutate : publicSnapshotMutate,
    } as never;
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  capabilitiesMutate.mockResolvedValue(capabilities);
  publicSnapshotMutate.mockResolvedValue(publicSnapshot);
  mockSWR();
});

describe('useEnterprisePlatformData', () => {
  it('uses null SWR keys and disabled synchronous fallbacks when fetching is gated off', () => {
    const { result } = renderHook(() =>
      useEnterprisePlatformData({
        disableFetch: false,
        enterpriseEnabled: false,
        serverConfigInit: true,
      }),
    );

    expect(vi.mocked(useClientDataSWR).mock.calls.map(([key]) => key)).toEqual([null, null]);
    expect(result.current.capabilities).toBe(DISABLED_PLATFORM_CAPABILITIES);
    expect(result.current.publicSnapshot).toEqual(DISABLED_PLATFORM_PUBLIC_SNAPSHOT);
    expect(result.current.loading).toBe(false);
  });

  it('never polls the authenticated capabilities endpoint for an anonymous visitor', () => {
    // Enterprise features are on by default, so the sign-in page mounts this provider.
    // `platform.getCapabilities` is authenticated — polling it anonymously would 401 on a
    // loop. The public snapshot (branding / login options) must still load.
    renderHook(() =>
      useEnterprisePlatformData({
        disableFetch: false,
        enterpriseEnabled: true,
        isSignedIn: false,
        serverConfigInit: true,
      }),
    );

    const [capabilitiesKey, publicSnapshotKey] = vi
      .mocked(useClientDataSWR)
      .mock.calls.map(([key]) => key);
    expect(capabilitiesKey).toBeNull();
    expect(publicSnapshotKey).not.toBeNull();
  });

  it('polls capabilities once a session exists', () => {
    renderHook(() =>
      useEnterprisePlatformData({
        disableFetch: false,
        enterpriseEnabled: true,
        isSignedIn: true,
        serverConfigInit: true,
      }),
    );

    expect(vi.mocked(useClientDataSWR).mock.calls[0]![0]).toBe(PLATFORM_CAPABILITIES_SWR_KEY);
  });

  it('configures bounded snapshot polling and a fallback for loading/error continuity', () => {
    renderHook(() =>
      useEnterprisePlatformData({
        disableFetch: false,
        enterpriseEnabled: true,
        serverConfigInit: true,
      }),
    );

    expect(vi.mocked(useClientDataSWR)).toHaveBeenNthCalledWith(
      1,
      PLATFORM_CAPABILITIES_SWR_KEY,
      expect.any(Function),
      expect.objectContaining({
        fallbackData: DISABLED_PLATFORM_CAPABILITIES,
        refreshInterval: PLATFORM_CAPABILITIES_REFRESH_INTERVAL,
      }),
    );
    expect(vi.mocked(useClientDataSWR)).toHaveBeenNthCalledWith(
      2,
      [PLATFORM_PUBLIC_SNAPSHOT_SWR_KEY, '0', null],
      expect.any(Function),
      expect.objectContaining({
        dedupingInterval: PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
        fallbackData: DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
        refreshInterval: PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
      }),
    );
  });

  it('uses the strict injected snapshot synchronously before background revalidation', () => {
    const initialPublicSnapshot: PlatformPublicSnapshot = {
      ...publicSnapshot,
      branding: { ...publicSnapshot.branding!, name: 'Initial Brand', revision: '3' },
      brandingRevision: '3',
      configRevision: 'config-3',
      platformName: 'Initial Brand',
    };
    mockSWR({ useFallbackData: true });

    const { result } = renderHook(() =>
      useEnterprisePlatformData({
        disableFetch: false,
        enterpriseEnabled: true,
        initialPublicSnapshot,
        serverConfigInit: true,
      }),
    );

    expect(result.current.publicSnapshot).toEqual(initialPublicSnapshot);
    expect(vi.mocked(useClientDataSWR)).toHaveBeenNthCalledWith(
      2,
      [PLATFORM_PUBLIC_SNAPSHOT_SWR_KEY, 'config-3', '3'],
      expect.any(Function),
      expect.objectContaining({ fallbackData: initialPublicSnapshot }),
    );
  });

  it('fails closed when the injected snapshot is inconsistent', () => {
    const inconsistentSnapshot = {
      ...publicSnapshot,
      brandingRevision: 'different',
      platformName: 'Different',
    } as PlatformPublicSnapshot;
    mockSWR({ useFallbackData: true });

    const { result } = renderHook(() =>
      useEnterprisePlatformData({
        disableFetch: false,
        enterpriseEnabled: true,
        initialPublicSnapshot: inconsistentSnapshot,
        serverConfigInit: true,
      }),
    );

    expect(result.current.publicSnapshot).toEqual(DISABLED_PLATFORM_PUBLIC_SNAPSHOT);
  });

  it('retains last-known data while exposing a fetch error', () => {
    mockSWR({ publicError: new Error('snapshot offline') });
    const { result } = renderHook(() =>
      useEnterprisePlatformData({
        disableFetch: false,
        enterpriseEnabled: true,
        serverConfigInit: true,
      }),
    );

    expect(result.current.publicSnapshot).toEqual(publicSnapshot);
    expect(result.current.error?.message).toBe('snapshot offline');
  });

  it('refetches both SWR resources on demand', async () => {
    const { result } = renderHook(() =>
      useEnterprisePlatformData({
        disableFetch: false,
        enterpriseEnabled: true,
        serverConfigInit: true,
      }),
    );

    await act(async () => result.current.refresh());
    expect(capabilitiesMutate).toHaveBeenCalledOnce();
    expect(publicSnapshotMutate).toHaveBeenCalledOnce();
  });

  describe('aiProviders enforcement transition', () => {
    const capabilitiesWith = (overrides: Partial<PlatformCapabilities>): PlatformCapabilities => ({
      ...capabilities,
      ...overrides,
      managedResources: {
        ...capabilities.managedResources,
        ...overrides.managedResources,
      },
    });

    const takenOver = capabilitiesWith({
      aiTakeover: true,
      configRevision: '7',
      managedResources: { ...capabilities.managedResources, aiProviders: true },
    });
    const notTakenOver = capabilitiesWith({
      aiTakeover: false,
      configRevision: '6',
      managedResources: { ...capabilities.managedResources, aiProviders: false },
    });
    // 平台托管 ended by switching to `ui-only`: the UI-blocking boolean stays true while the
    // server-side runtime takeover is off.
    const uiOnly = capabilitiesWith({
      aiTakeover: false,
      configRevision: '8',
      managedResources: { ...capabilities.managedResources, aiProviders: true },
    });

    const mockCapabilities = (value: PlatformCapabilities) => {
      vi.mocked(useClientDataSWR).mockImplementation((key) => {
        const isCapabilities = key === PLATFORM_CAPABILITIES_SWR_KEY;
        return {
          data: isCapabilities ? value : publicSnapshot,
          error: undefined,
          isLoading: false,
          mutate: isCapabilities ? capabilitiesMutate : publicSnapshotMutate,
        } as never;
      });
    };

    const renderWith = (value: PlatformCapabilities) => {
      mockCapabilities(value);
      return renderHook(() =>
        useEnterprisePlatformData({
          disableFetch: false,
          enterpriseEnabled: true,
          serverConfigInit: true,
        }),
      );
    };

    it('matches every aiInfra cache whose content depends on platform takeover', () => {
      expect(isAiInfraPlatformSensitiveSwrKey('FETCH_AI_PROVIDER')).toBe(true);
      expect(isAiInfraPlatformSensitiveSwrKey(['FETCH_AI_PROVIDER_RUNTIME_STATE', true])).toBe(
        true,
      );
      expect(isAiInfraPlatformSensitiveSwrKey('admin:FETCH_AI_PROVIDER')).toBe(true);
      expect(
        isAiInfraPlatformSensitiveSwrKey(['admin', 'FETCH_AI_PROVIDER_RUNTIME_STATE', false, 'ws']),
      ).toBe(true);
      expect(isAiInfraPlatformSensitiveSwrKey(['aiModel:list', 'chatgpt'])).toBe(true);
      expect(isAiInfraPlatformSensitiveSwrKey(PLATFORM_CAPABILITIES_SWR_KEY)).toBe(false);
      expect(isAiInfraPlatformSensitiveSwrKey(['session:list'])).toBe(false);
      expect(isAiInfraPlatformSensitiveSwrKey(null)).toBe(false);
    });

    it('does not invalidate aiInfra caches on the first observed capability value', () => {
      renderWith(takenOver);

      expect(mutate).not.toHaveBeenCalled();
    });

    it('invalidates aiInfra caches when 平台托管 starts and when it ends', () => {
      const { rerender } = renderWith(notTakenOver);
      expect(mutate).not.toHaveBeenCalled();

      mockCapabilities(takenOver);
      rerender();
      expect(mutate).toHaveBeenCalledExactlyOnceWith(isAiInfraPlatformSensitiveSwrKey);

      // A re-render with the same value must not re-invalidate …
      rerender();
      expect(mutate).toHaveBeenCalledOnce();

      // … while the end of enforcement must.
      mockCapabilities(notTakenOver);
      rerender();
      expect(mutate).toHaveBeenCalledTimes(2);
    });

    it('detects enforced → ui-only and ui-only → enforced, which the UI boolean cannot', () => {
      const { rerender } = renderWith(takenOver);
      expect(mutate).not.toHaveBeenCalled();

      // enforced → ui-only: `managedResources.aiProviders` stays true, but the server has
      // handed the runtime back to the user.
      mockCapabilities(uiOnly);
      rerender();
      expect(uiOnly.managedResources.aiProviders).toBe(takenOver.managedResources.aiProviders);
      expect(mutate).toHaveBeenCalledTimes(1);

      // ui-only → enforced.
      mockCapabilities(capabilitiesWith({ ...takenOver, configRevision: '9' }));
      rerender();
      expect(mutate).toHaveBeenCalledTimes(2);
    });

    it('re-invalidates past the server takeover memo horizon so a stale first fetch cannot stick', () => {
      vi.useFakeTimers();
      try {
        const { rerender, unmount } = renderWith(notTakenOver);
        mockCapabilities(takenOver);
        rerender();
        expect(mutate).toHaveBeenCalledOnce();

        // The server memoizes the takeover predicate briefly, so the immediate fetch may still
        // be answered from the old regime. Nothing else would ever refresh it.
        vi.advanceTimersByTime(AI_CACHE_TRANSITION_SETTLE_DELAY - 1);
        expect(mutate).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(1);
        expect(mutate).toHaveBeenCalledTimes(2);
        expect(mutate).toHaveBeenLastCalledWith(isAiInfraPlatformSensitiveSwrKey);

        // No further passes, and unmount does not leave a pending timer.
        vi.advanceTimersByTime(AI_CACHE_TRANSITION_SETTLE_DELAY * 3);
        expect(mutate).toHaveBeenCalledTimes(2);
        unmount();
        vi.advanceTimersByTime(AI_CACHE_TRANSITION_SETTLE_DELAY * 3);
        expect(mutate).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('does not forward SWR cache keys into the service query-injection boundary', async () => {
    const fetchCapabilities = vi.fn().mockResolvedValue(capabilities);
    const fetchPublicSnapshot = vi.fn().mockResolvedValue(publicSnapshot);
    renderHook(() =>
      useEnterprisePlatformData({
        disableFetch: false,
        enterpriseEnabled: true,
        fetchCapabilities,
        fetchPublicSnapshot,
        serverConfigInit: true,
      }),
    );
    const capabilitiesFetcher = vi.mocked(useClientDataSWR).mock.calls[0][1];
    const publicSnapshotFetcher = vi.mocked(useClientDataSWR).mock.calls[1][1];

    await capabilitiesFetcher?.(['unexpected-swr-key'] as never);
    await publicSnapshotFetcher?.(['unexpected-swr-key'] as never);

    expect(fetchCapabilities).toHaveBeenCalledWith();
    expect(fetchPublicSnapshot).toHaveBeenCalledWith();
  });
});

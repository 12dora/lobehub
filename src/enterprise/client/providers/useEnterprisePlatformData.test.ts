import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useClientDataSWR } from '@/libs/swr';
import {
  DISABLED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

import {
  PLATFORM_CAPABILITIES_SWR_KEY,
  PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
  PLATFORM_PUBLIC_SNAPSHOT_SWR_KEY,
  useEnterprisePlatformData,
} from './useEnterprisePlatformData';

vi.mock('@/libs/swr', () => ({ useClientDataSWR: vi.fn() }));

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
      expect.objectContaining({ fallbackData: DISABLED_PLATFORM_CAPABILITIES }),
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

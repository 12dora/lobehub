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

const mockSWR = (options?: { capabilitiesError?: unknown; publicError?: unknown }) => {
  vi.mocked(useClientDataSWR).mockImplementation((key) => {
    const isCapabilities = key === PLATFORM_CAPABILITIES_SWR_KEY;
    return {
      data: isCapabilities ? capabilities : publicSnapshot,
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
    expect(result.current.publicSnapshot).toBe(DISABLED_PLATFORM_PUBLIC_SNAPSHOT);
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
      PLATFORM_PUBLIC_SNAPSHOT_SWR_KEY,
      expect.any(Function),
      expect.objectContaining({
        dedupingInterval: PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
        fallbackData: DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
        refreshInterval: PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
      }),
    );
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

    expect(result.current.publicSnapshot).toBe(publicSnapshot);
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
});

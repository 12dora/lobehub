'use client';

import { useCallback } from 'react';

import { useClientDataSWR } from '@/libs/swr';
import {
  DISABLED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from '../services/platform';

export const PLATFORM_CAPABILITIES_SWR_KEY = 'platform.getCapabilities';
export const PLATFORM_PUBLIC_SNAPSHOT_SWR_KEY = 'platform.getPublicSnapshot';
export const PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL = 30_000;

export interface UseEnterprisePlatformDataOptions {
  disableFetch: boolean;
  enterpriseEnabled: boolean;
  fetchCapabilities?: typeof fetchPlatformCapabilities;
  fetchPublicSnapshot?: typeof fetchPlatformPublicSnapshot;
  serverConfigInit: boolean;
}

export interface EnterprisePlatformData {
  capabilities: PlatformCapabilities;
  error: Error | null;
  loading: boolean;
  publicSnapshot: PlatformPublicSnapshot;
  refresh: () => Promise<void>;
}

const toError = (error: unknown): Error | null => {
  if (!error) return null;
  return error instanceof Error ? error : new Error(String(error));
};

/** SWR-backed bootstrap with a synchronous built-in fallback and revision polling. */
export const useEnterprisePlatformData = ({
  disableFetch,
  enterpriseEnabled,
  fetchCapabilities = fetchPlatformCapabilities,
  fetchPublicSnapshot = fetchPlatformPublicSnapshot,
  serverConfigInit,
}: UseEnterprisePlatformDataOptions): EnterprisePlatformData => {
  const enabled = !disableFetch && serverConfigInit && enterpriseEnabled;
  const capabilitiesSWR = useClientDataSWR<PlatformCapabilities>(
    enabled ? PLATFORM_CAPABILITIES_SWR_KEY : null,
    fetchCapabilities,
    {
      fallbackData: DISABLED_PLATFORM_CAPABILITIES,
      revalidateOnFocus: true,
    },
  );
  const publicSnapshotSWR = useClientDataSWR<PlatformPublicSnapshot>(
    enabled ? PLATFORM_PUBLIC_SNAPSHOT_SWR_KEY : null,
    fetchPublicSnapshot,
    {
      dedupingInterval: PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
      fallbackData: DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      refreshInterval: PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
      revalidateOnFocus: true,
    },
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    await Promise.all([capabilitiesSWR.mutate(), publicSnapshotSWR.mutate()]);
  }, [capabilitiesSWR, enabled, publicSnapshotSWR]);

  if (!enabled) {
    return {
      capabilities: DISABLED_PLATFORM_CAPABILITIES,
      error: null,
      loading: false,
      publicSnapshot: DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      refresh,
    };
  }

  return {
    capabilities: capabilitiesSWR.data ?? DISABLED_PLATFORM_CAPABILITIES,
    error: toError(capabilitiesSWR.error ?? publicSnapshotSWR.error),
    loading: Boolean(capabilitiesSWR.isLoading || publicSnapshotSWR.isLoading),
    publicSnapshot: publicSnapshotSWR.data ?? DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
    refresh,
  };
};

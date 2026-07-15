'use client';

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  DISABLED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from '../services/platform';

export interface EnterprisePlatformContextValue {
  capabilities: PlatformCapabilities;
  error: Error | null;
  loading: boolean;
  publicSnapshot: PlatformPublicSnapshot;
  refresh: () => Promise<void>;
}

const EnterprisePlatformContext = createContext<EnterprisePlatformContextValue | null>(null);

export interface EnterprisePlatformProviderProps {
  children: ReactNode;
  /**
   * When true, skip remote fetches (tests / offline). Defaults to false.
   * Flag-off server responses still match DISABLED_* snapshots.
   */
  disableFetch?: boolean;
}

/**
 * Initializes public platform capability context.
 * Default snapshots match closed feature flags so the UI matches upstream LobeHub
 * until server flags and RBAC grant capabilities.
 */
export default function EnterprisePlatformProvider({
  children,
  disableFetch = false,
}: EnterprisePlatformProviderProps) {
  const [capabilities, setCapabilities] = useState<PlatformCapabilities>(
    DISABLED_PLATFORM_CAPABILITIES,
  );
  const [publicSnapshot, setPublicSnapshot] = useState<PlatformPublicSnapshot>(
    DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (disableFetch) return;

    setLoading(true);
    setError(null);
    try {
      const [nextCapabilities, nextPublic] = await Promise.all([
        fetchPlatformCapabilities(),
        fetchPlatformPublicSnapshot(),
      ]);
      setCapabilities(nextCapabilities);
      setPublicSnapshot(nextPublic);
    } catch (err) {
      // Keep last-known / disabled snapshot so the app stays usable when enterprise is off.
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [disableFetch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<EnterprisePlatformContextValue>(
    () => ({
      capabilities,
      error,
      loading,
      publicSnapshot,
      refresh,
    }),
    [capabilities, error, loading, publicSnapshot, refresh],
  );

  return <EnterprisePlatformContext value={value}>{children}</EnterprisePlatformContext>;
}

export const useEnterprisePlatform = (): EnterprisePlatformContextValue => {
  const ctx = use(EnterprisePlatformContext);
  if (!ctx) {
    // Safe fallback for tests or partial trees — never throw when flags are off.
    return {
      capabilities: DISABLED_PLATFORM_CAPABILITIES,
      error: null,
      loading: false,
      publicSnapshot: DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      refresh: async () => {},
    };
  }
  return ctx;
};

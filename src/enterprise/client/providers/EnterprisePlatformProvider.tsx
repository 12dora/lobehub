'use client';

import { createContext, type ReactNode, use, useEffect, useMemo } from 'react';

import { useServerConfigStore } from '@/store/serverConfig';
import { useToolStore } from '@/store/tool';
import {
  DISABLED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

import { usePublishedSkillCatalog } from '../features/skills';
import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from '../services/platform';
import { RuntimeBrandingProvider } from './RuntimeBrandingProvider';
import { useEnterprisePlatformData } from './useEnterprisePlatformData';

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
  fetchCapabilities?: typeof fetchPlatformCapabilities;
  fetchPublicSnapshot?: typeof fetchPlatformPublicSnapshot;
  initialPublicSnapshot?: PlatformPublicSnapshot;
}

/**
 * Initializes public platform capability context.
 *
 * Network policy (M00 DoD):
 * - Default state is DISABLED_* (no admin / managed resources).
 * - Does **not** call platform.* until `config.getGlobalConfig` has hydrated and
 *   `serverConfig.enterprise.enabled === true` (any enterprise env flag on).
 * - When all flags are off, cold start adds **zero** platform.* requests.
 */
export default function EnterprisePlatformProvider({
  children,
  disableFetch = false,
  fetchCapabilities = fetchPlatformCapabilities,
  fetchPublicSnapshot = fetchPlatformPublicSnapshot,
  initialPublicSnapshot = DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
}: EnterprisePlatformProviderProps) {
  const serverConfigInit = useServerConfigStore((s) => s.serverConfigInit);
  const enterpriseEnabled = useServerConfigStore(
    (s) => s.serverConfig.enterprise?.enabled === true,
  );

  const { capabilities, error, loading, publicSnapshot, refresh } = useEnterprisePlatformData({
    disableFetch,
    enterpriseEnabled,
    fetchCapabilities,
    fetchPublicSnapshot,
    initialPublicSnapshot,
    serverConfigInit,
  });

  usePublishedSkillCatalog(capabilities.managedResources.skills);

  useEffect(() => {
    useToolStore.getState().configurePlatformSkillManagement(capabilities.managedResources.skills);
  }, [capabilities.managedResources.skills]);

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

  return (
    <EnterprisePlatformContext value={value}>
      <RuntimeBrandingProvider publicSnapshot={publicSnapshot}>{children}</RuntimeBrandingProvider>
    </EnterprisePlatformContext>
  );
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

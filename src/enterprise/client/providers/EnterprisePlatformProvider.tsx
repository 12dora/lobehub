'use client';

import { type ReactNode, useEffect, useMemo } from 'react';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import { useServerConfigStore } from '@/store/serverConfig';
import { useToolStore } from '@/store/tool';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

import { usePublishedSkillCatalog } from '../features/skills';
import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from '../services/platform';
import {
  EnterprisePlatformContext,
  type EnterprisePlatformContextValue,
  useEnterprisePlatform,
} from './enterprisePlatformContext';
import { RuntimeBrandingProvider } from './RuntimeBrandingProvider';
import { useEnterprisePlatformData } from './useEnterprisePlatformData';
import { usePlatformSettingLockSync } from './usePlatformSettingLockSync';

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
  const isSignedIn = Boolean(useUserStore(authSelectors.isLogin));
  // Inline rather than via `userProfileSelectors` so this stays independent of
  // the user-selectors module surface.
  const userId = useUserStore((s) => s.user?.id);
  const workspaceId = useActiveWorkspaceId();

  const { capabilities, capabilitiesReady, error, loading, publicSnapshot, refresh } =
    useEnterprisePlatformData({
      disableFetch,
      enterpriseEnabled,
      fetchCapabilities,
      fetchPublicSnapshot,
      initialPublicSnapshot,
      isSignedIn,
      serverConfigInit,
    });

  // Publish the platform lock mirror from bootstrap, so non-React callers
  // (store actions / agent-run transports) never have to guess while no managed
  // field is mounted. Keyed on account + workspace + policy revision so a switch
  // re-primes instead of leaving the previous answer readable.
  usePlatformSettingLockSync({
    capabilitiesReady,
    enterpriseEnabled,
    isSignedIn,
    policyIdentity: `${userId ?? ''}|${workspaceId ?? ''}|${capabilities.configRevision ?? ''}`,
    serverConfigInit,
    userSettingsPolicyEnabled: capabilities.userSettingsPolicyEnabled === true,
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

// Re-exported so the many existing `from './EnterprisePlatformProvider'` call sites keep working;
// new read-only consumers should import from `./enterprisePlatformContext` instead.
export { type EnterprisePlatformContextValue, useEnterprisePlatform };

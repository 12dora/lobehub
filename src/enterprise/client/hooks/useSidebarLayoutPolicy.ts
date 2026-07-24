'use client';

import { fetchPlatformSidebarLayoutPolicy } from '@/enterprise/client/services/platform';
import { useClientDataSWR } from '@/libs/swr';
import { useServerConfigStore } from '@/store/serverConfig';
import {
  DEFAULT_SIDEBAR_LAYOUT_POLICY,
  type SidebarLayoutPolicy,
} from '@/types/platform/sidebarLayout';

export const SIDEBAR_LAYOUT_POLICY_KEY = 'platform-sidebar-layout-policy';

/**
 * The effective home-sidebar layout policy for the current user.
 * Fails open (mode 'user', not managed) so the sidebar stays user-customizable when the
 * policy is unavailable. SWR dedupes across every consumer (one fetch per home load).
 *
 * Default-off: while `enterprise.platformAdmin` is not hydrated/true, no platform RPC is issued
 * and the user-controlled default is returned — matching the server flag gate.
 */
export const useSidebarLayoutPolicy = (): SidebarLayoutPolicy => {
  const serverConfigInit = useServerConfigStore((s) => s.serverConfigInit);
  const platformAdmin = useServerConfigStore(
    (s) => s.serverConfig.enterprise?.platformAdmin === true,
  );
  // Wait for config hydrate; only fetch when platform admin feature exists.
  const enabled = serverConfigInit && platformAdmin;

  const { data } = useClientDataSWR<SidebarLayoutPolicy>(
    enabled ? [SIDEBAR_LAYOUT_POLICY_KEY] : null,
    () => fetchPlatformSidebarLayoutPolicy(),
    { revalidateOnFocus: false },
  );
  return data ?? DEFAULT_SIDEBAR_LAYOUT_POLICY;
};

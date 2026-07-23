'use client';

import { fetchPlatformSidebarLayoutPolicy } from '@/enterprise/client/services/platform';
import { useClientDataSWR } from '@/libs/swr';
import {
  DEFAULT_SIDEBAR_LAYOUT_POLICY,
  type SidebarLayoutPolicy,
} from '@/types/platform/sidebarLayout';

export const SIDEBAR_LAYOUT_POLICY_KEY = 'platform-sidebar-layout-policy';

/**
 * The effective home-sidebar layout policy for the current user.
 * Fails open (mode 'user', not managed) so the sidebar stays user-customizable when the
 * policy is unavailable. SWR dedupes across every consumer (one fetch per home load).
 */
export const useSidebarLayoutPolicy = (): SidebarLayoutPolicy => {
  const { data } = useClientDataSWR<SidebarLayoutPolicy>(
    [SIDEBAR_LAYOUT_POLICY_KEY],
    () => fetchPlatformSidebarLayoutPolicy(),
    { revalidateOnFocus: false },
  );
  return data ?? DEFAULT_SIDEBAR_LAYOUT_POLICY;
};

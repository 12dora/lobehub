'use client';

import { useClientDataSWR } from '@/libs/swr';
import { lambdaClient } from '@/libs/trpc/client';
import { useServerConfigStore } from '@/store/serverConfig';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';

export const ADMIN_ENTRY_ACCESS_KEY = 'platform-admin-entry-access';

/**
 * Dedupe window for the entry probe. The answer only changes when an admin edits platform
 * roles, so the menu may reuse a recent snapshot instead of re-querying on every panel open.
 */
export const ADMIN_ENTRY_ACCESS_DEDUPING_INTERVAL = 60_000;

/**
 * Whether the admin-console entry belongs in the user panel for the current user.
 *
 * Fails closed: no request for anonymous users or when the platform admin feature is off
 * (`enterprise.platformAdmin` — the same flag that decides whether `/admin` is registered in
 * the route tree), and `false` until the server answers, so non-admins never see it flash.
 * The permission snapshot is session-scoped and never persisted.
 */
export const useHasAdminEntry = (): boolean => {
  const serverConfigInit = useServerConfigStore((s) => s.serverConfigInit);
  const platformAdmin = useServerConfigStore(
    (s) => s.serverConfig.enterprise?.platformAdmin === true,
  );
  const isLogin = useUserStore(authSelectors.isLogin);
  const enabled = Boolean(isLogin) && serverConfigInit && platformAdmin;

  const { data } = useClientDataSWR<{ hasAdminAccess: boolean }>(
    enabled ? [ADMIN_ENTRY_ACCESS_KEY] : null,
    () => lambdaClient.admin.auth.getMyAccess.query(),
    {
      dedupingInterval: ADMIN_ENTRY_ACCESS_DEDUPING_INTERVAL,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  return enabled && data?.hasAdminAccess === true;
};

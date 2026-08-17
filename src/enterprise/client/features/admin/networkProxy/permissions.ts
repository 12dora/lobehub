import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

export interface NetworkProxyPermissions {
  /** Change anything: master switch, outlet, subscriptions, scopes, engine install / restart. */
  canManage: boolean;
  /** See the tab at all (auditor gets this through the read-only role bundle). */
  canRead: boolean;
}

/**
 * Single place the 网络代理 tab derives its gates from (design §5).
 *
 * Read-only admins still see every control — disabled with an explanation — so it stays
 * obvious that the capability exists and who to ask for it.
 */
export const deriveNetworkProxyPermissions = (
  granted: readonly string[],
): NetworkProxyPermissions => {
  const set = new Set(granted);
  return {
    canManage: set.has(PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE),
    canRead: set.has(PLATFORM_PERMISSIONS.NETWORK_PROXY_READ),
  };
};

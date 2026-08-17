/**
 * Authorization facts for every Next.js route under `src/app/(backend)/webapi/admin/**`.
 * Each `route.ts` must have exactly one entry; the sibling test walks the directory.
 */
import { PLATFORM_PERMISSIONS, type PlatformPermission } from '@/const/platform/permissions';

export type AdminWebapiHttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export interface AdminWebapiRouteEntry {
  dangerous: boolean;
  method: AdminWebapiHttpMethod;
  path: string;
  permission: PlatformPermission;
  rateLimit: 'admin-mutation';
  reauth: boolean;
}

export const ADMIN_WEBAPI_ROUTE_REGISTRY = [
  {
    dangerous: true,
    method: 'POST',
    path: '/webapi/admin/network-proxy/artifact',
    permission: PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE,
    rateLimit: 'admin-mutation',
    reauth: true,
  },
] as const satisfies readonly AdminWebapiRouteEntry[];

export type AdminWebapiRoutePath = (typeof ADMIN_WEBAPI_ROUTE_REGISTRY)[number]['path'];

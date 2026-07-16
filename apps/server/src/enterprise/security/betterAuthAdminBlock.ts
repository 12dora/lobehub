/**
 * Block Better Auth built-in admin mutation endpoints when platform admin is on (M04).
 * Platform RBAC + reason + reauth + audit is the sole management surface.
 */
import { isPlatformAdminFeatureEnabled } from '../featureFlags';

/** Paths relative to Better Auth base path (typically `/api/auth`). */
export const PLATFORM_BLOCKED_BETTER_AUTH_ADMIN_PATHS = [
  '/admin/ban-user',
  '/admin/unban-user',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/set-role',
  '/admin/remove-user',
  '/admin/impersonate-user',
  '/admin/stop-impersonating',
  '/admin/set-user-password',
  '/admin/create-user',
  '/admin/update-user',
  '/admin/list-users',
  '/admin/list-user-sessions',
  '/admin/get-user',
  '/admin/user-has-permission',
] as const;

export type BlockedBetterAuthAdminPath = (typeof PLATFORM_BLOCKED_BETTER_AUTH_ADMIN_PATHS)[number];

/**
 * Extract Better Auth path suffix after `/api/auth`.
 * Accepts full URLs or pathnames.
 */
export const extractBetterAuthPath = (url: string): string => {
  try {
    const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0] || '';
    const marker = '/api/auth';
    const idx = pathname.indexOf(marker);
    if (idx >= 0) {
      const rest = pathname.slice(idx + marker.length) || '/';
      return rest.startsWith('/') ? rest : `/${rest}`;
    }
    // Already a relative auth path like `/admin/ban-user`
    return pathname.startsWith('/') ? pathname : `/${pathname}`;
  } catch {
    return '/';
  }
};

export const isBlockedBetterAuthAdminPath = (authPath: string): boolean => {
  const normalized = authPath.split('?')[0]?.replace(/\/+$/, '') || '/';
  return (PLATFORM_BLOCKED_BETTER_AUTH_ADMIN_PATHS as readonly string[]).includes(normalized);
};

/**
 * When ENABLE_PLATFORM_ADMIN is on, forbidden admin plugin mutations return 403.
 * Flag-off: no-op (upstream Better Auth admin plugin remains available).
 */
export const maybeBlockBetterAuthAdminMutation = (requestUrl: string): Response | null => {
  if (!isPlatformAdminFeatureEnabled()) return null;

  const path = extractBetterAuthPath(requestUrl);
  if (!isBlockedBetterAuthAdminPath(path)) return null;

  return Response.json(
    {
      code: 'ADMIN_FEATURE_DISABLED',
      message:
        'Better Auth admin mutations are disabled when platform admin is enabled. Use admin.users / admin.roles APIs.',
    },
    { status: 403 },
  );
};

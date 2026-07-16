import { lambdaClient } from '@/libs/trpc/client';

/**
 * Access snapshot from `admin.auth.getMyAccess`.
 * Permissions are session-scoped and must not be persisted client-side.
 */
export interface AdminAccessSnapshot {
  /**
   * Server-authenticated method (from lambda context). Used to choose reauth strategy.
   * Clients must not invent this — trust the server only.
   */
  authMethod?: 'better-auth' | 'oidc' | 'api-key' | 'dev-mock' | null;
  hasAdminAccess: boolean;
  permissions: string[];
  roles: Array<{ displayName: string | null; name: string }>;
}

export type FetchAdminAccess = () => Promise<AdminAccessSnapshot>;

/**
 * Production adapter for admin access. Tests inject a mock via AdminAccessProvider.
 * Never caches permissions beyond the current in-memory provider state.
 */
export const fetchAdminAccess: FetchAdminAccess = async () => {
  return lambdaClient.admin.auth.getMyAccess.query();
};

/** Extract tRPC / HTTP style error code when present. */
export const getAdminAccessErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;

  const data = (error as { data?: { code?: unknown } }).data;
  if (typeof data?.code === 'string') return data.code;

  const shape = (error as { shape?: { data?: { code?: unknown } } }).shape;
  if (typeof shape?.data?.code === 'string') return shape.data.code;

  return undefined;
};

/**
 * 401/UNAUTHORIZED and 403/FORBIDDEN are not retryable for access grants.
 * Network / 5xx failures remain retryable.
 */
export const isAdminAccessErrorRetryable = (error: unknown): boolean => {
  const code = getAdminAccessErrorCode(error);
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return false;

  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message ?? '');
    if (/UNAUTHORIZED|FORBIDDEN|401|403/i.test(message)) return false;
  }

  return true;
};

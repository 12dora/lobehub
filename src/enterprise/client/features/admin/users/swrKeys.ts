import type { AdminUsersListInput } from '@/server/enterprise/contracts/adminUsers';

import { DEFAULT_PAGE_SIZE } from '../primitives/dataTableChange';

export const ADMIN_USERS_LIST_KEY = 'admin.users.list' as const;
export const ADMIN_USERS_DETAIL_KEY = 'admin.users.get' as const;
export const ADMIN_USERS_AUDIT_KEY = 'admin.users.getAuditTrail' as const;

/** Normalized list key — stable for SWR dedupe; never logs full query. */
export const buildAdminUsersListKey = (
  filters: AdminUsersListInput & { cursor?: string | null; offset?: number },
) => {
  const limit = filters.limit ?? DEFAULT_PAGE_SIZE;
  const offset = filters.offset ?? 0;
  return [
    ADMIN_USERS_LIST_KEY,
    filters.query ?? '',
    filters.status ?? '',
    filters.role ?? '',
    filters.createdFrom?.toISOString?.() ??
      (filters.createdFrom ? String(filters.createdFrom) : ''),
    filters.createdTo?.toISOString?.() ?? (filters.createdTo ? String(filters.createdTo) : ''),
    offset,
    limit,
    filters.source ?? '',
    filters.cursor ?? '',
  ] as const;
};

export const buildAdminUsersDetailKey = (userId: string) =>
  [ADMIN_USERS_DETAIL_KEY, userId] as const;

/**
 * An omitted `limit` is sent as `undefined`, so the SERVER's default decides the page —
 * normalize to the same value the server would apply (`ADMIN_USERS_AUDIT_DEFAULT_LIMIT`,
 * kept equal to the shared UI default) so an omitted-limit page never shares a cache entry
 * with a differently sized explicit request.
 */
export const buildAdminUsersAuditKey = (params: {
  cursor?: string | null;
  limit?: number;
  userId: string;
}) =>
  [
    ADMIN_USERS_AUDIT_KEY,
    params.userId,
    params.cursor ?? '',
    params.limit ?? DEFAULT_PAGE_SIZE,
  ] as const;

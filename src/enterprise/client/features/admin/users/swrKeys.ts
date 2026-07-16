import type { AdminUsersListInput } from '@/server/enterprise/contracts/adminUsers';

export const ADMIN_USERS_LIST_KEY = 'admin.users.list' as const;
export const ADMIN_USERS_DETAIL_KEY = 'admin.users.get' as const;
export const ADMIN_USERS_AUDIT_KEY = 'admin.users.getAuditTrail' as const;

/** Normalized list key — stable for SWR dedupe; never logs full query. */
export const buildAdminUsersListKey = (
  filters: AdminUsersListInput & { cursor?: string | null },
) => {
  const limit = filters.limit ?? 50;
  return [
    ADMIN_USERS_LIST_KEY,
    filters.query ?? '',
    filters.status ?? '',
    filters.role ?? '',
    filters.createdFrom?.toISOString?.() ??
      (filters.createdFrom ? String(filters.createdFrom) : ''),
    filters.createdTo?.toISOString?.() ?? (filters.createdTo ? String(filters.createdTo) : ''),
    filters.cursor ?? '',
    limit,
  ] as const;
};

export const buildAdminUsersDetailKey = (userId: string) =>
  [ADMIN_USERS_DETAIL_KEY, userId] as const;

export const buildAdminUsersAuditKey = (params: {
  cursor?: string | null;
  limit?: number;
  userId: string;
}) => [ADMIN_USERS_AUDIT_KEY, params.userId, params.cursor ?? '', params.limit ?? 50] as const;

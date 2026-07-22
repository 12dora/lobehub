'use client';

import { useCallback } from 'react';
import { mutate } from 'swr';

import {
  type AdminUsersBanInput,
  type AdminUsersDeleteInput,
  type AdminUsersGetAuditTrailInput,
  type AdminUsersListInput,
  type AdminUsersReplaceGlobalRolesInput,
  type AdminUsersRevokeSessionsInput,
  adminUsersService,
  type AdminUsersUnbanInput,
} from '@/enterprise/client/services/adminUsers';
import { useClientDataSWR } from '@/libs/swr';

import {
  ADMIN_USERS_AUDIT_KEY,
  ADMIN_USERS_LIST_KEY,
  buildAdminUsersAuditKey,
  buildAdminUsersDetailKey,
  buildAdminUsersListKey,
} from '../swrKeys';

export type AdminUsersListFilters = AdminUsersListInput & {
  cursor?: string | null;
};

export const useFetchAdminUsersList = (filters: AdminUsersListFilters, enabled = true) => {
  const key = enabled ? buildAdminUsersListKey(filters) : null;
  return useClientDataSWR(key, () =>
    adminUsersService.list({
      createdFrom: filters.createdFrom,
      createdTo: filters.createdTo,
      cursor: filters.cursor ?? undefined,
      limit: filters.limit,
      query: filters.query,
      role: filters.role,
      status: filters.status,
    }),
  );
};

export const useFetchAdminUserDetail = (userId: string | undefined, enabled = true) => {
  const key = enabled && userId ? buildAdminUsersDetailKey(userId) : null;
  return useClientDataSWR(key, () => adminUsersService.get({ userId: userId! }));
};

/**
 * Audit trail is only requested when the tab is active AND the principal has audit read.
 * Callers must pass `enabled=false` when unauthorized or tab inactive.
 */
export const useFetchAdminUserAuditTrail = (
  params: AdminUsersGetAuditTrailInput & { cursor?: string | null },
  enabled: boolean,
) => {
  const key =
    enabled && params.userId
      ? buildAdminUsersAuditKey({
          cursor: params.cursor,
          limit: params.limit,
          userId: params.userId,
        })
      : null;

  return useClientDataSWR(key, () =>
    adminUsersService.getAuditTrail({
      cursor: params.cursor ?? undefined,
      limit: params.limit,
      userId: params.userId,
    }),
  );
};

export const refreshAdminUsersList = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_USERS_LIST_KEY);
};

export const refreshAdminUserDetail = async (userId: string) => {
  await mutate(buildAdminUsersDetailKey(userId));
  await mutate(
    (key) => Array.isArray(key) && key[0] === ADMIN_USERS_AUDIT_KEY && key[1] === userId,
  );
};

export const useAdminUserMutations = () => {
  const banUser = useCallback(async (input: AdminUsersBanInput) => {
    const result = await adminUsersService.ban(input);
    await refreshAdminUsersList();
    await refreshAdminUserDetail(input.userId);
    return result;
  }, []);

  const unbanUser = useCallback(async (input: AdminUsersUnbanInput) => {
    const result = await adminUsersService.unban(input);
    await refreshAdminUsersList();
    await refreshAdminUserDetail(input.userId);
    return result;
  }, []);

  const deleteUser = useCallback(async (input: AdminUsersDeleteInput) => {
    const result = await adminUsersService.deleteUser(input);
    // User row is gone — refresh the list; the detail key resolves to not-found.
    await refreshAdminUsersList();
    return result;
  }, []);

  const revokeSessions = useCallback(async (input: AdminUsersRevokeSessionsInput) => {
    const result = await adminUsersService.revokeSessions(input);
    await refreshAdminUsersList();
    await refreshAdminUserDetail(input.userId);
    return result;
  }, []);

  const replaceGlobalRoles = useCallback(async (input: AdminUsersReplaceGlobalRolesInput) => {
    const result = await adminUsersService.replaceGlobalRoles(input);
    await refreshAdminUsersList();
    await refreshAdminUserDetail(input.userId);
    return result;
  }, []);

  return { banUser, deleteUser, replaceGlobalRoles, revokeSessions, unbanUser };
};

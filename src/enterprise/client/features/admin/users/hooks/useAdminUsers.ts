'use client';

import { toast } from '@lobehub/ui/base-ui';
import debug from 'debug';
import i18n from 'i18next';
import { useCallback } from 'react';

import {
  type AdminUsersBanInput,
  type AdminUsersCreateInput,
  type AdminUsersDeleteInput,
  type AdminUsersGetAuditTrailInput,
  type AdminUsersListInput,
  type AdminUsersReplaceGlobalRolesInput,
  type AdminUsersRevokeSessionsInput,
  adminUsersService,
  type AdminUsersUnbanInput,
} from '@/enterprise/client/services/adminUsers';
import { mutate, useClientDataSWR } from '@/libs/swr';

import {
  ADMIN_USERS_AUDIT_KEY,
  ADMIN_USERS_LIST_KEY,
  buildAdminUsersAuditKey,
  buildAdminUsersDetailKey,
  buildAdminUsersListKey,
} from '../swrKeys';

const log = debug('lobe-client:admin:users');

export type AdminUsersListFilters = AdminUsersListInput & {
  cursor?: string | null;
  offset?: number;
};

export const useFetchAdminUsersList = (filters: AdminUsersListFilters, enabled = true) => {
  const key = enabled ? buildAdminUsersListKey(filters) : null;
  return useClientDataSWR(key, () =>
    adminUsersService.list({
      createdFrom: filters.createdFrom,
      createdTo: filters.createdTo,
      cursor: filters.cursor ?? undefined,
      limit: filters.limit,
      offset: filters.offset,
      query: filters.query,
      role: filters.role,
      source: filters.source,
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

const invalidateAdminUsersList = () =>
  mutate((key) => Array.isArray(key) && key[0] === ADMIN_USERS_LIST_KEY);

const invalidateAdminUserDetail = (userId: string) => mutate(buildAdminUsersDetailKey(userId));

const invalidateAdminUserAudit = (userId: string) =>
  mutate((key) => Array.isArray(key) && key[0] === ADMIN_USERS_AUDIT_KEY && key[1] === userId);

export const refreshAdminUsersList = async () => {
  await invalidateAdminUsersList();
};

/**
 * Best-effort cache invalidation after a successful mutation.
 * Never rethrows — a refresh failure must not surface as a mutation failure
 * (would invite unsafe retries of irreversible commits). Surfaces a toast instead.
 *
 * Independent tasks run via Promise.allSettled so a single key failure still
 * attempts list/detail/audit invalidations.
 */
const softRefresh = async (tasks: Array<() => Promise<unknown>>) => {
  const results = await Promise.allSettled(tasks.map((task) => task()));
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (!rejected) return;

  log('post-commit refresh failed: %O', rejected.reason);
  toast.warning(
    String(
      i18n.t('users.toast.savedRefreshFailed' as never, {
        defaultValue: 'Saved, but the latest view could not be refreshed.',
        ns: 'admin',
      }),
    ),
  );
};

/** List + detail + audit invalidations for user-scoped mutations. */
const softRefreshUserCaches = (userId: string) =>
  softRefresh([
    () => invalidateAdminUsersList(),
    () => invalidateAdminUserDetail(userId),
    () => invalidateAdminUserAudit(userId),
  ]);

export const useAdminUserMutations = () => {
  const createUser = useCallback(async (input: AdminUsersCreateInput) => {
    const result = await adminUsersService.create(input);
    await softRefresh([() => invalidateAdminUsersList()]);
    return result;
  }, []);

  const banUser = useCallback(async (input: AdminUsersBanInput) => {
    const result = await adminUsersService.ban(input);
    await softRefreshUserCaches(input.userId);
    return result;
  }, []);

  const unbanUser = useCallback(async (input: AdminUsersUnbanInput) => {
    const result = await adminUsersService.unban(input);
    await softRefreshUserCaches(input.userId);
    return result;
  }, []);

  const deleteUser = useCallback(async (input: AdminUsersDeleteInput) => {
    const result = await adminUsersService.deleteUser(input);
    // User row is gone — refresh the list; the detail key resolves to not-found.
    await softRefresh([() => invalidateAdminUsersList()]);
    return result;
  }, []);

  const revokeSessions = useCallback(async (input: AdminUsersRevokeSessionsInput) => {
    const result = await adminUsersService.revokeSessions(input);
    await softRefreshUserCaches(input.userId);
    return result;
  }, []);

  const replaceGlobalRoles = useCallback(async (input: AdminUsersReplaceGlobalRolesInput) => {
    const result = await adminUsersService.replaceGlobalRoles(input);
    await softRefreshUserCaches(input.userId);
    return result;
  }, []);

  return { banUser, createUser, deleteUser, replaceGlobalRoles, revokeSessions, unbanUser };
};

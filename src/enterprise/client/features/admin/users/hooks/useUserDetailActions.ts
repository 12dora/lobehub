'use client';

import type { TFunction } from 'i18next';
import { useCallback } from 'react';
import type { NavigateFunction } from 'react-router';

import { type PlatformSystemRoleName, resolvePlatformRoleLabel } from '@/const/platform/roles';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminUsersGetOutput } from '@/enterprise/client/services/adminUsers';

import {
  openBanUserModal,
  openDeleteUserModal,
  openReplaceRolesModal,
  openRevokeRoleModal,
  openRevokeSessionsModal,
  openRevokeSingleSessionModal,
  openUnbanUserModal,
} from '../modals/actions';
import { displayUserName } from '../utils';
import type { useAdminUserMutations } from './useAdminUsers';

export interface UseUserDetailActionsParams {
  actorRoles: readonly { name: string }[];
  authMethod?: AdminReauthAuthMethod | null;
  data: AdminUsersGetOutput | undefined;
  mutations: Pick<
    ReturnType<typeof useAdminUserMutations>,
    'banUser' | 'deleteUser' | 'replaceGlobalRoles' | 'revokeSessions' | 'unbanUser'
  >;
  navigate: NavigateFunction;
  t: TFunction<'admin'>;
  userId: string | undefined;
}

export const useUserDetailActions = ({
  actorRoles,
  authMethod,
  data,
  mutations,
  navigate,
  t,
  userId,
}: UseUserDetailActionsParams) => {
  const { banUser, deleteUser, replaceGlobalRoles, revokeSessions, unbanUser } = mutations;

  // Post-commit SWR refresh lives inside useAdminUserMutations (soft — never fails the mutation).
  // Do not await a second mutate() here: a refresh rejection would surface as a mutation failure.

  const openBan = useCallback(() => {
    if (!data || !userId || data.isSelf) return;
    openBanUserModal({
      authMethod,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await banUser(input);
      },
    });
  }, [authMethod, banUser, data, userId]);

  const openUnban = useCallback(() => {
    if (!data || !userId || data.isSelf) return;
    openUnbanUserModal({
      authMethod,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await unbanUser(input);
      },
    });
  }, [authMethod, data, unbanUser, userId]);

  const openDelete = useCallback(() => {
    if (!data || !userId || data.isSelf) return;
    openDeleteUserModal({
      authMethod,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await deleteUser(input);
        // The user is gone — return to the list.
        navigate('/admin/users');
      },
    });
  }, [authMethod, data, deleteUser, navigate, userId]);

  const openRevokeAll = useCallback(() => {
    if (!data || !userId) return;
    openRevokeSessionsModal({
      authMethod,
      isSelf: data.isSelf,
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await revokeSessions(input);
      },
    });
  }, [authMethod, data, revokeSessions, userId]);

  const openRevokeSingle = useCallback(
    (sessionId: string) => {
      if (!data || !userId) return;
      openRevokeSingleSessionModal({
        authMethod,
        isSelf: data.isSelf,
        sessionId,
        targetLabel: displayUserName(data),
        userId,
        onConfirm: async (input) => {
          await revokeSessions(input);
        },
      });
    },
    [authMethod, data, revokeSessions, userId],
  );

  const openUpdatePermissions = useCallback(() => {
    if (!data || !userId) return;
    openReplaceRolesModal({
      actorRoles,
      authMethod,
      // Pass full grants so the modal can preserve per-role expiry and protected roles.
      currentRoles: data.roles.map((r) => ({ expiresAt: r.expiresAt ?? null, name: r.name })),
      targetLabel: displayUserName(data),
      userId,
      onConfirm: async (input) => {
        await replaceGlobalRoles(input);
      },
    });
  }, [actorRoles, authMethod, data, replaceGlobalRoles, userId]);

  const openRevokeRole = useCallback(
    (roleName: string) => {
      if (!data || !userId) return;
      const remaining = data.roles
        .map((r) => r.name)
        .filter((name) => name !== roleName) as PlatformSystemRoleName[];
      const revoked = data.roles.find((r) => r.name === roleName);
      const revokedRoleLabel = resolvePlatformRoleLabel(
        { displayName: revoked?.displayName, name: roleName },
        (key, options) => String(t(key as never, { defaultValue: options?.defaultValue })),
      );
      openRevokeRoleModal({
        authMethod,
        remainingRoleNames: remaining,
        revokedRoleLabel,
        targetLabel: displayUserName(data),
        userId,
        onConfirm: async (input) => {
          await replaceGlobalRoles(input);
        },
      });
    },
    [authMethod, data, replaceGlobalRoles, t, userId],
  );

  return {
    openBan,
    openDelete,
    openRevokeAll,
    openRevokeRole,
    openRevokeSingle,
    openUnban,
    openUpdatePermissions,
  };
};

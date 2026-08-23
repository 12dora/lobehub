'use client';

import { useMemo } from 'react';

import { useAdminUserMutations } from '../hooks/useAdminUsers';

/**
 * The seven mutations the detail body hands to `useUserDetailActions`, bundled into one
 * stable object so the action openers are not rebuilt on every render.
 */
export const useUserDetailMutationBundle = () => {
  const {
    banUser,
    unbanUser,
    deleteUser,
    disableUserTwoFactor,
    revokeSessions,
    replaceGlobalRoles,
    setUserPassword,
  } = useAdminUserMutations();

  return useMemo(
    () => ({
      banUser,
      deleteUser,
      disableUserTwoFactor,
      replaceGlobalRoles,
      revokeSessions,
      setUserPassword,
      unbanUser,
    }),
    [
      banUser,
      deleteUser,
      disableUserTwoFactor,
      replaceGlobalRoles,
      revokeSessions,
      setUserPassword,
      unbanUser,
    ],
  );
};

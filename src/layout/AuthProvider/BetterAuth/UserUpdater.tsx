'use client';

import { memo, useEffect } from 'react';
import { createStoreUpdater } from 'zustand-utils';

import { useSession } from '@/libs/better-auth/auth-client';
import { useUserStore } from '@/store/user';
import { type LobeUser } from '@/types/user';

interface SessionErrorLike {
  status?: number;
}

/**
 * Decide the next signed-in state from the latest `useSession` snapshot.
 *
 * - A successful response containing a user is authoritative: signed in.
 *   (Better-auth also preserves the previous session data on non-401 errors,
 *   which lands here and correctly keeps the user signed in.)
 * - A successful empty response (no user, no error) is authoritative: signed out.
 * - A definitive 401 means the session is gone: signed out.
 * - Any other error (network failure while the server restarts, 5xx, …) is
 *   transient: keep the last known state instead of flipping a signed-in user
 *   to signed-out and bouncing them to /signin. Better-auth refetches (focus,
 *   refresh manager) and will deliver an authoritative answer later.
 */
export const resolveIsSignedIn = (options: {
  error: SessionErrorLike | null | undefined;
  hasUser: boolean;
  prevIsSignedIn: boolean;
}): boolean => {
  const { error, hasUser, prevIsSignedIn } = options;

  if (hasUser) return true;
  if (!error) return false;
  if (error.status === 401) return false;

  return prevIsSignedIn;
};

/**
 * Sync Better-Auth session state to Zustand store
 */
const UserUpdater = memo(() => {
  const { data: session, isPending, error } = useSession();

  const isLoaded = !isPending;
  const isSignedIn = resolveIsSignedIn({
    error,
    hasUser: !!session?.user,
    prevIsSignedIn: !!useUserStore.getState().isSignedIn,
  });

  const betterAuthUser = session?.user;
  const useStoreUpdater = createStoreUpdater(useUserStore);

  useStoreUpdater('isLoaded', isLoaded);
  useStoreUpdater('isSignedIn', isSignedIn);

  // Sync user data from Better-Auth session to Zustand store.
  // Better-Auth refetches the session on tab focus (visibilitychange), which
  // gives us a new `betterAuthUser` reference each time even when the
  // underlying user is unchanged. We must merge into the existing user rather
  // than replace it — fields like `interests`, `firstName`, `latestName` are
  // populated by `useInitUserState` (one-shot SWR) and would otherwise be
  // wiped on every focus, breaking downstream selectors (e.g. the daily-brief
  // recommendation SWR key resets to empty interests and refetches). .
  //
  // Guard the merge by user id: if the session switches to a different
  // account (e.g. another tab signed in as a different user, focus refetch
  // returns the new session here without an intermediate signed-out state),
  // drop the previous user's profile fields so they don't leak across
  // accounts. `useInitUserState` is `useOnlyFetchOnceSWR` with a constant
  // key, so it won't re-fetch profile data for the new user on its own.
  useEffect(() => {
    if (betterAuthUser) {
      useUserStore.setState((state) => {
        const baseUser = state.user?.id === betterAuthUser.id ? state.user : undefined;
        return {
          user: {
            ...baseUser,
            // Preserve avatar from settings, don't override with auth provider value
            avatar: baseUser?.avatar || '',
            email: betterAuthUser.email,
            fullName: betterAuthUser.name,
            id: betterAuthUser.id,
            username: betterAuthUser.username,
          } as LobeUser,
        };
      });
      return;
    }

    // Clear user data only on an authoritative signed-out (empty session or
    // 401). During a transient session-fetch error we keep the last known
    // profile so the UI doesn't flash to a logged-out state.
    if (!isSignedIn) {
      useUserStore.setState({ user: undefined });
    }
  }, [betterAuthUser, isSignedIn]);

  return null;
});

export default UserUpdater;

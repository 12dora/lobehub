'use client';

import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/** Search param that drives the slide-in detail panel — shareable and Back-closable. */
const SELECTED_USER_PARAM = 'user';

/** Owns the `?user=` param: which row the slide-in panel shows, and how it opens/closes. */
export const useSelectedUserPanel = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Push on open so Back closes the panel; replace on close so Back does not reopen it.
  const openUserPanel = useCallback(
    (userId: string) => {
      const next = new URLSearchParams(searchParams);
      next.set(SELECTED_USER_PARAM, userId);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const closeUserPanel = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete(SELECTED_USER_PARAM);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return { closeUserPanel, openUserPanel, selectedUserId: searchParams.get(SELECTED_USER_PARAM) };
};

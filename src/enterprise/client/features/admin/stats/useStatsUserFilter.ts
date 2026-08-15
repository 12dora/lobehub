'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { adminUsersService } from '@/enterprise/client/services/adminUsers';
import { useClientDataSWR } from '@/libs/swr';

import { displayStatsUserLabel } from './StatsUserFilterSelect';

/** Mirrors the server's `userIdSchema` (min 1 / max 128). */
const MAX_USER_ID_LENGTH = 128;

/**
 * Read `?user=` as a usable id, or `null`.
 *
 * `?user=` (empty) or `?user=%20` would otherwise travel as `userId: ''` and be rejected
 * by every stats procedure; an over-long value can never match a real user.
 */
export const parseStatsUserIdParam = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.length > MAX_USER_ID_LENGTH) return null;
  return trimmed;
};

export interface StatsUserFilterControls {
  /** Select a user (with its known label) or clear back to "all users". */
  setUser: (userId?: string, name?: string) => void;
  userId?: string;
  /** Best known label for `userId`: picked name → directory lookup → the raw id. */
  userName?: string;
}

/**
 * URL-backed single-user filter for the admin stats page.
 *
 * The id in the URL is canonicalized (trimmed, bounded, dropped when unusable) so the
 * queries, the picker and the banner can never disagree about who is selected. A
 * bookmarked or shared `?user=<id>` is resolved through the directory so the picker shows
 * a name instead of "全部用户"; when the lookup fails (deleted user, no USER_READ) the id
 * itself is the label — still true, never a stale name from a previous selection.
 */
export const useStatsUserFilter = (): StatsUserFilterControls => {
  const [searchParams, setSearchParams] = useSearchParams();

  const rawUser = searchParams.get('user');
  const userId = parseStatsUserIdParam(rawUser);

  // Label of the user picked in this session — saves a lookup for the common path.
  const [picked, setPicked] = useState<{ id: string; name: string } | undefined>();

  const writeUser = useCallback(
    (next: string | null) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next) params.set('user', next);
          else params.delete('user');
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (rawUser === null || rawUser === userId) return;
    writeUser(userId);
  }, [rawUser, userId, writeUser]);

  const pickedName = picked && picked.id === userId ? picked.name : undefined;

  const { data: lookedUpName } = useClientDataSWR(
    userId && !pickedName ? ['admin-stats:user-label', userId] : null,
    async (): Promise<string | null> => {
      try {
        const user = await adminUsersService.get({ userId: userId! });
        return displayStatsUserLabel(user);
      } catch {
        // Deleted user, or an admin without USER_READ — the id stays the label.
        return null;
      }
    },
  );

  const setUser = useCallback(
    (nextId?: string, name?: string) => {
      const canonical = parseStatsUserIdParam(nextId ?? null);
      setPicked(canonical && name ? { id: canonical, name } : undefined);
      writeUser(canonical);
    },
    [writeUser],
  );

  return {
    setUser,
    userId: userId ?? undefined,
    userName: userId ? (pickedName ?? lookedUpName ?? userId) : undefined,
  };
};

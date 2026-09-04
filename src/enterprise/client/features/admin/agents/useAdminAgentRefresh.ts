'use client';

import { useMemo } from 'react';

export interface UseAdminAgentRefreshParams {
  /** `mutate` bound to `ADMIN_AGENT_DEFAULT_KEY` — the pinned card's own SWR entry. */
  refreshDefaultAgent: () => Promise<unknown>;
  /** The bound `useSWRInfinite` mutate over the loaded table pages. */
  refreshList: () => Promise<unknown>;
}

/**
 * The two SWR surfaces this page renders the same assistants through, and how a committed write
 * invalidates them together.
 */
export interface AdminAgentRefresh {
  /**
   * Table AND pinned card. `listWrite` substitutes the list half with the caller's own operation
   * (an optimistic row patch or drop) when it describes the row better than a plain revalidate.
   */
  defaultAndList: (listWrite?: () => Promise<unknown>) => Promise<void>;
  /** The pinned card alone. */
  defaultOnly: () => Promise<void>;
  /** The table alone — only for writes that provably cannot touch the default pointer. */
  listOnly: (listWrite?: () => Promise<unknown>) => Promise<void>;
}

export const createAdminAgentRefresh = ({
  refreshDefaultAgent,
  refreshList,
}: UseAdminAgentRefreshParams): AdminAgentRefresh => {
  const listOnly = async (listWrite: () => Promise<unknown> = refreshList) => {
    await listWrite();
  };
  const defaultOnly = async () => {
    await refreshDefaultAgent();
  };

  return {
    defaultAndList: async (listWrite) => {
      // allSettled, not Promise.all: a rejected list revalidation must NOT skip the pinned key, or
      // the card keeps rendering the assistant / name / avatar / model this write just replaced.
      // The first failure is still rethrown, so the caller reports "this view may be behind".
      const settled = await Promise.allSettled([listOnly(listWrite), defaultOnly()]);
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason;
      }
    },
    defaultOnly,
    listOnly,
  };
};

/**
 * One invalidator for every write on the assistant list.
 *
 * The pinned 默认助理 card and the table are separate cache entries over the SAME assistants, so a
 * mutation that refreshes only the table leaves the card asserting a default the server no longer
 * has. Every action hook on this page takes this object instead of a bare list refresher, which is
 * what makes "which keys does this write invalidate?" a decision made once, here.
 */
export const useAdminAgentRefresh = ({
  refreshDefaultAgent,
  refreshList,
}: UseAdminAgentRefreshParams): AdminAgentRefresh =>
  useMemo(
    () => createAdminAgentRefresh({ refreshDefaultAgent, refreshList }),
    [refreshDefaultAgent, refreshList],
  );

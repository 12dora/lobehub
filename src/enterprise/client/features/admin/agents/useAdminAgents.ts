'use client';

import { useEffect } from 'react';
import useSWRInfinite from 'swr/infinite';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';
import { useClientDataSWR, useClientPollingSWR } from '@/libs/swr';
import { adminPlatformAgentDetailAggregateOutputSchema } from '@/server/enterprise/contracts/platformAgents';

import {
  ADMIN_AGENT_LIST_KEY,
  buildAdminAgentGetKey,
  buildAdminAgentRolloutPollKey,
} from './swrKeys';
import type {
  AdminAgentDetailOutput,
  AdminAgentListInput,
  AdminAgentListItem,
  AdminAgentListOutput,
  AdminAgentsClient,
} from './types';
import { sortPlatformAgentVersionsDesc } from './versionSelection';

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Hard cap on cursor-followed collection drains (detail aggregate + catalog preflights).
 * 20 pages × 100 items = 2,000 rows max per collection — enough for admin surfaces without
 * unbounded memory growth or a stuck cursor cycle.
 */
export const ADMIN_AGENT_COLLECTION_PAGE_LIMIT = 20;

const collectPages = async <T>(fetchPage: (cursor?: string) => Promise<CursorPage<T>>) => {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (cursor) {
      // Cycle-safe: a repeating opaque cursor must not spin forever.
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < ADMIN_AGENT_COLLECTION_PAGE_LIMIT);
  return items;
};

/**
 * Dedicated default-inbox pointer read — single list request with `isDefault: true`.
 * Never page-walks the catalog; a miss means there is no default, not "past page 20".
 */
export const findDefaultAdminAgent = async (
  client: AdminAgentsClient,
): Promise<AdminAgentListItem | undefined> => {
  const page = await client.list({ isDefault: true, limit: 1 });
  return page.items.find(({ identity }) => identity.isDefault) ?? page.items[0];
};

/**
 * One page of published replacement candidates for archive-default, optionally filtered by
 * server-side `query`. Callers that need more results re-query (search / load-more) — never
 * silently drain the catalog and drop candidates past a page ceiling.
 */
export const fetchPublishedAdminAgentReplacements = async (
  excludeAgentId: string,
  client: AdminAgentsClient,
  options: { limit?: number; query?: string } = {},
): Promise<AdminAgentListItem[]> => {
  const page = await client.list({
    limit: options.limit ?? 50,
    query: options.query,
    status: 'published',
  });
  return page.items.filter(({ identity }) => identity.id !== excludeAgentId);
};

export const fetchAdminAgentDetail = async (
  id: string,
  client: AdminAgentsClient,
  rolloutsEnabled = client.capabilities.rollouts,
): Promise<AdminAgentDetailOutput> => {
  const [detail, assignments, rollouts, versions] = await Promise.all([
    client.get({ id }),
    collectPages((cursor) => client.listAssignments({ agentId: id, cursor, limit: 100 })),
    // Skip the read entirely when the server capability is off, rather than touching a gated API.
    rolloutsEnabled
      ? collectPages((cursor) => client.listRollouts({ agentId: id, cursor, limit: 100 }))
      : Promise.resolve([] as AdminAgentDetailOutput['rollouts']),
    collectPages((cursor) => client.listVersions({ agentId: id, cursor, limit: 100 })),
  ]);

  // API boundary: validate the assembled aggregate against the authoritative contract schema — the
  // SAME schema the refresh gate uses to prove freshness. A malformed authoritative response is a
  // hard error here rather than silently trusted downstream.
  //
  // Canonical version order at the aggregate boundary: newest createdAt first (id tie-break).
  // Repository pages are ordered by opaque id and MUST NOT be treated as creation order.
  return adminPlatformAgentDetailAggregateOutputSchema.parse({
    ...detail,
    assignments,
    rollouts,
    versions: sortPlatformAgentVersionsDesc(versions),
  }) as AdminAgentDetailOutput;
};

const ACTIVE_ROLLOUT_POLL_LIMIT = 20;
const isActiveRollout = ({ status }: AdminAgentDetailOutput['rollouts'][number]) =>
  status === 'pending' || status === 'running';

export const selectActiveRolloutJobIds = (detail?: AdminAgentDetailOutput): string[] =>
  [...new Set(detail?.rollouts.filter(isActiveRollout).map(({ jobId }) => jobId) ?? [])].slice(
    0,
    ACTIVE_ROLLOUT_POLL_LIMIT,
  );

export const fetchActiveAdminAgentRollouts = async (
  agentId: string,
  jobIds: string[],
  client: AdminAgentsClient,
) => Promise.all(jobIds.map((jobId) => client.getRollout({ agentId, jobId })));

export const mergePolledRollouts = (
  detail: AdminAgentDetailOutput,
  polled: AdminAgentDetailOutput['rollouts'],
): AdminAgentDetailOutput => {
  const byJobId = new Map(polled.map((rollout) => [rollout.jobId, rollout]));
  return {
    ...detail,
    rollouts: detail.rollouts.map((rollout) => byJobId.get(rollout.jobId) ?? rollout),
  };
};

export interface AdminAgentListPagination {
  /**
   * The AsyncBoundary "settled" signal: `undefined` until the first page resolves (so the real
   * AsyncBoundary shows loading/first-error), then the (possibly empty) accumulated items.
   */
  boundaryData: AdminAgentListItem[] | undefined;
  error: unknown;
  hasMore: boolean;
  isEmpty: boolean;
  isLoadingInitial: boolean;
  isLoadingMore: boolean;
  items: AdminAgentListItem[];
  loadMore: () => void;
  /** A later page (not the first) failed — surfaced inline without discarding settled content. */
  loadMoreError: boolean;
  /**
   * Revalidate every loaded infinite page via the bound `useSWRInfinite` mutate.
   * Prefer this over global key-predicate mutates after create/delete — global `mutate(filter)`
   * does not reliably refresh infinite caches.
   */
  refresh: () => Promise<void>;
  /**
   * Optimistically drop a deleted agent from every loaded page, then revalidate. Delete is already
   * committed server-side, so a failed revalidate must not resurrect a still-actionable row.
   */
  removeItem: (agentId: string) => Promise<void>;
  retry: () => void;
}

/**
 * Cursor-paginated Agent list. Follows the server `nextCursor` explicitly (never silently
 * truncated at one page), dedupes by identity id, and resets when the filter/search input
 * changes (the input is part of the SWR-infinite key).
 */
export const useAdminAgentListPagination = (
  input: Omit<AdminAgentListInput, 'cursor'>,
  enabled: boolean,
  client: AdminAgentsClient = adminAgentsService,
): AdminAgentListPagination => {
  const swr = useSWRInfinite<AdminAgentListOutput>(
    (index, previous: AdminAgentListOutput | null) => {
      if (!enabled) return null;
      if (previous && previous.nextCursor === null) return null;
      const cursor = index === 0 ? undefined : (previous?.nextCursor ?? undefined);
      return [ADMIN_AGENT_LIST_KEY, input, cursor] as const;
    },
    ([, listInput, cursor]: readonly [
      string,
      Omit<AdminAgentListInput, 'cursor'>,
      string | undefined,
    ]) => client.list({ ...listInput, cursor }),
    { revalidateFirstPage: false, revalidateOnFocus: false },
  );

  const pages = swr.data ?? [];
  const seen = new Set<string>();
  const items: AdminAgentListItem[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.identity.id)) continue;
      seen.add(item.identity.id);
      items.push(item);
    }
  }

  const loadedPages = swr.data?.length ?? 0;
  const settled = swr.data !== undefined; // the first page has resolved at least once
  const isReachingEnd = loadedPages > 0 && (pages.at(-1)?.nextCursor ?? null) === null;
  // SWR keeps the previous error while a retry is in flight. Drive the first-load gate from the
  // real request state so Retry returns to loading feedback instead of leaving a clickable stale
  // error surface on screen.
  const isLoadingInitial = enabled && !settled && swr.isValidating;

  return {
    // Undefined before the first settle so a real AsyncBoundary renders loading / first error.
    boundaryData: settled ? items : undefined,
    error: swr.error,
    hasMore: enabled && !isReachingEnd,
    isEmpty: settled && items.length === 0,
    isLoadingInitial,
    // A pending page beyond those already materialized means "loading more", not initial load.
    isLoadingMore: swr.isValidating && loadedPages > 0 && swr.size > loadedPages,
    // A later-page failure keeps settled content on screen and is surfaced inline instead.
    loadMoreError: settled && Boolean(swr.error),
    items,
    loadMore: () => void swr.setSize((size) => size + 1),
    // Bound infinite mutate — revalidates the active cursor pages, not a global key filter.
    refresh: async () => {
      await swr.mutate();
    },
    removeItem: async (agentId: string) => {
      await swr.mutate(
        (pages) =>
          pages?.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.identity.id !== agentId),
          })),
        { revalidate: true },
      );
    },
    retry: () => void swr.mutate(),
  };
};

export const useFetchAdminAgent = (
  id: string | undefined,
  enabled: boolean,
  client: AdminAgentsClient = adminAgentsService,
  rolloutsEnabled = client.capabilities.rollouts,
) => {
  const detail = useClientDataSWR<AdminAgentDetailOutput>(
    buildAdminAgentGetKey(id, enabled, rolloutsEnabled),
    () => fetchAdminAgentDetail(id!, client, rolloutsEnabled),
    {
      // Identity-changing keys must not retain agent A while agent B loads — the detail page
      // would render/mutate A under B's URL (including when B fails and A sticks indefinitely).
      keepPreviousData: false,
      revalidateOnFocus: false,
    },
  );
  const activeJobIds = rolloutsEnabled ? selectActiveRolloutJobIds(detail.data) : [];
  const rolloutPoll = useClientPollingSWR<AdminAgentDetailOutput['rollouts']>(
    buildAdminAgentRolloutPollKey(id, activeJobIds),
    () => fetchActiveAdminAgentRollouts(id!, activeJobIds, client),
    {
      dedupingInterval: 1000,
      refreshInterval: 2000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  useEffect(() => {
    if (!rolloutPoll.data) return;
    void detail.mutate(
      (current) => (current ? mergePolledRollouts(current, rolloutPoll.data!) : current),
      { revalidate: false },
    );
  }, [detail.mutate, rolloutPoll.data]);

  return {
    ...detail,
    retryRolloutPoll: rolloutPoll.mutate,
    rolloutPollError: rolloutPoll.error,
  };
};

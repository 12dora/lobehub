'use client';

import { mutate } from 'swr';
import useSWRInfinite from 'swr/infinite';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';
import { useClientDataSWR, useClientPollingSWR } from '@/libs/swr';
import { adminPlatformAgentDetailAggregateOutputSchema } from '@/server/enterprise/contracts/platformAgents';

import {
  ADMIN_AGENT_GET_KEY,
  ADMIN_AGENT_LIST_KEY,
  buildAdminAgentGetKey,
  buildAdminAgentListKey,
} from './swrKeys';
import type {
  AdminAgentDetailOutput,
  AdminAgentListInput,
  AdminAgentListItem,
  AdminAgentListOutput,
  AdminAgentsClient,
} from './types';

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

const collectPages = async <T>(fetchPage: (cursor?: string) => Promise<CursorPage<T>>) => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
};

export const fetchAllAdminAgents = async (
  input: Omit<AdminAgentListInput, 'cursor' | 'limit'>,
  client: AdminAgentsClient,
) => collectPages((cursor) => client.list({ ...input, cursor, limit: 100 }));

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
  return adminPlatformAgentDetailAggregateOutputSchema.parse({
    ...detail,
    assignments,
    rollouts,
    versions,
  }) as AdminAgentDetailOutput;
};

export const useFetchAdminAgents = (
  input: AdminAgentListInput,
  enabled: boolean,
  client: AdminAgentsClient = adminAgentsService,
) =>
  useClientDataSWR(buildAdminAgentListKey(input, enabled), () => client.list(input), {
    revalidateOnFocus: false,
  });

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
    retry: () => void swr.mutate(),
  };
};

export const useFetchAdminAgent = (
  id: string | undefined,
  enabled: boolean,
  client: AdminAgentsClient = adminAgentsService,
  rolloutsEnabled = client.capabilities.rollouts,
) =>
  useClientPollingSWR(
    buildAdminAgentGetKey(id, enabled, rolloutsEnabled),
    () => fetchAdminAgentDetail(id!, client, rolloutsEnabled),
    {
      dedupingInterval: 1000,
      keepPreviousData: true,
      refreshInterval: (latest: AdminAgentDetailOutput | undefined) =>
        rolloutsEnabled &&
        latest?.rollouts.some(({ status }) => status === 'pending' || status === 'running')
          ? 2000
          : 0,
      revalidateOnFocus: false,
    },
  );

export const refreshAdminAgentLists = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_AGENT_LIST_KEY);
};

export const refreshAdminAgent = async (id: string) => {
  const [detail] = await Promise.all([
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_AGENT_GET_KEY && key[1] === id),
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_AGENT_LIST_KEY),
  ]);
  return detail;
};

export const clearAdminAgentCache = async () => {
  await mutate(
    (key) =>
      Array.isArray(key) && (key[0] === ADMIN_AGENT_GET_KEY || key[0] === ADMIN_AGENT_LIST_KEY),
    undefined,
    { revalidate: false },
  );
};

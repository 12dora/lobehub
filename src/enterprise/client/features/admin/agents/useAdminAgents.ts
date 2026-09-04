'use client';

import useSWRInfinite from 'swr/infinite';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';
import { useClientDataSWR } from '@/libs/swr';
import { adminPlatformAgentDetailAggregateOutputSchema } from '@/server/enterprise/contracts/platformAgents';

import { ADMIN_AGENT_DEFAULT_KEY, ADMIN_AGENT_LIST_KEY } from './swrKeys';
import type {
  AdminAgentCollectionMeta,
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

export interface CollectedPages<T> {
  items: T[];
  nextCursor: string | null;
  /** True when the page ceiling stopped the drain while a next cursor remained. */
  truncated: boolean;
}

const toCollectedPage = <T>({ items, nextCursor }: CursorPage<T>): CollectedPages<T> => ({
  items,
  nextCursor,
  truncated: nextCursor !== null,
});

/**
 * Page ceilings for the aggregate drains. Bounded, because an unbounded loop against a hostile or
 * broken cursor is a hang; `truncated` stays true when the ceiling is what stopped us, so callers
 * can say "this list is incomplete" instead of silently editing a partial view.
 */
const MAX_ASSIGNMENT_PAGES = 20;
const MAX_VERSION_PAGES = 20;
const PAGE_LIMIT = 100;

/**
 * Drain a cursor collection until it is exhausted, the page ceiling is hit, or `stopWhen` says the
 * row we actually needed has arrived. Ids are opaque, so "keep paging until found" is the only way
 * to guarantee a specific row is present.
 */
const drainPages = async <T>(
  fetchPage: (cursor?: string) => Promise<CursorPage<T>>,
  maxPages: number,
  stopWhen?: (items: T[]) => boolean,
): Promise<CollectedPages<T>> => {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    cursor = result.nextCursor ?? undefined;
    if (!cursor) return { items, nextCursor: null, truncated: false };
    if (stopWhen?.(items)) return { items, nextCursor: cursor, truncated: false };
  }
  return { items, nextCursor: cursor ?? null, truncated: cursor !== null };
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
  const detail = await client.get({ id });
  // Versions are paged by OPAQUE id, so the published pointer can sit on any page. The editor
  // seeds from that exact version, so page until it is loaded rather than settling for whatever
  // the first page happened to hold.
  const wanted = detail.identity.currentVersionId;
  const [assignments, rollouts, versions] = await Promise.all([
    // Every assignment matters: the editor writes a diff against this list, so an unseen row would
    // read as "not present" and could be re-created into the unique (agent, target) index.
    drainPages<AdminAgentDetailOutput['assignments'][number]>(
      (cursor) => client.listAssignments({ agentId: id, cursor, limit: PAGE_LIMIT }),
      MAX_ASSIGNMENT_PAGES,
    ),
    // Skip the read entirely when the server capability is off, rather than touching a gated API.
    rolloutsEnabled
      ? client
          .listRollouts({ agentId: id, limit: PAGE_LIMIT })
          .then(toCollectedPage<AdminAgentDetailOutput['rollouts'][number]>)
      : Promise.resolve({
          items: [] as AdminAgentDetailOutput['rollouts'],
          nextCursor: null,
          truncated: false,
        }),
    drainPages<AdminAgentDetailOutput['versions'][number]>(
      (cursor) => client.listVersions({ agentId: id, cursor, limit: PAGE_LIMIT }),
      MAX_VERSION_PAGES,
      wanted ? (loaded) => loaded.some(({ id: versionId }) => versionId === wanted) : undefined,
    ),
  ]);

  const collectionMeta: AdminAgentCollectionMeta = {
    assignmentsNextCursor: assignments.nextCursor,
    assignmentsTruncated: assignments.truncated,
    rolloutsNextCursor: rollouts.nextCursor,
    rolloutsTruncated: rollouts.truncated,
    versionsNextCursor: versions.nextCursor,
    versionsTruncated: versions.truncated,
  };

  // API boundary: validate the assembled aggregate against the authoritative contract schema — the
  // SAME schema the refresh gate uses to prove freshness. A malformed authoritative response is a
  // hard error here rather than silently trusted downstream.
  //
  // Canonical version order at the aggregate boundary: newest createdAt first (id tie-break).
  // Repository pages are ordered by opaque id and MUST NOT be treated as creation order.
  return adminPlatformAgentDetailAggregateOutputSchema.parse({
    ...detail,
    assignments: assignments.items,
    collectionMeta,
    rollouts: rollouts.items,
    versions: sortPlatformAgentVersionsDesc(versions.items),
  }) as AdminAgentDetailOutput;
};

/**
 * What the pinned 默认助理 card renders: the pointer row, plus the published version behind it.
 * The list row carries neither an avatar nor a model — both live on the version config /
 * dependency snapshot, so the card needs the aggregate as well.
 */
export interface AdminDefaultAgentSnapshot {
  /** Null when the aggregate could not be read; the card degrades instead of disappearing. */
  detail: AdminAgentDetailOutput | null;
  item: AdminAgentListItem;
}

/**
 * Resolve the managed default assistant, or `null` when the platform has none (members are then
 * served the built-in inbox). The pointer read is the authoritative half: a failed aggregate read
 * costs the card its avatar and model line, never the pinned assistant itself.
 */
export const fetchDefaultAdminAgent = async (
  client: AdminAgentsClient = adminAgentsService,
): Promise<AdminDefaultAgentSnapshot | null> => {
  const item = await findDefaultAdminAgent(client);
  if (!item) return null;
  const detail = await fetchAdminAgentDetail(item.identity.id, client, false).catch(() => null);
  return { detail, item };
};

/**
 * The pinned default assistant. Its own SWR entry, deliberately separate from the paginated list:
 * the card must stay put while the table is searched, filtered, or paged.
 */
export const useDefaultAdminAgent = (
  enabled: boolean,
  client: AdminAgentsClient = adminAgentsService,
) =>
  useClientDataSWR<AdminDefaultAgentSnapshot | null>(
    enabled ? ADMIN_AGENT_DEFAULT_KEY : null,
    () => fetchDefaultAdminAgent(client),
    { revalidateOnFocus: false },
  );

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
  /**
   * Apply an authoritative post-commit projection to a loaded row, then revalidate. The write is
   * already committed server-side, so the row must show the new truth immediately; a rejected
   * revalidation is surfaced by the caller instead of leaving the pre-save row on screen.
   */
  updateItem: (
    agentId: string,
    apply: (item: AdminAgentListItem) => AdminAgentListItem,
  ) => Promise<void>;
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
    updateItem: async (agentId, apply) => {
      await swr.mutate(
        (pages) =>
          pages?.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.identity.id === agentId ? apply(item) : item)),
          })),
        { revalidate: true },
      );
    },
  };
};

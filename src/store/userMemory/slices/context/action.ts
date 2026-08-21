import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { useEffect } from 'react';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { type DisplayContextMemory } from '@/database/repositories/userMemory';
import { userMemoryKeys } from '@/libs/swr/keys';
import { memoryCRUDService, userMemoryService } from '@/services/userMemory';
import { type StoreSetter } from '@/store/types';
import { LayersEnum } from '@/types/userMemory';
import { setNamespace } from '@/utils/storeDebug';

import { type UserMemoryStore } from '../../store';
import { DEFAULT_MEMORY_LIST_PAGE_SIZE, memoryListQueryKey } from '../../utils/listQuery';
import { dropMemoryListCache } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/context');

export interface ContextQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'capturedAt' | 'scoreImpact' | 'scoreUrgency';
}

type ContextFilter = Omit<ContextQueryParams, 'page' | 'pageSize'>;

interface ContextListResponse {
  items: { context?: Record<string, unknown>; memory?: Record<string, unknown> }[];
  total: number;
}

/**
 * Every filter field of `ContextQueryParams` — pagination excluded.
 */
const contextQueryKey = (params?: ContextFilter): string =>
  memoryListQueryKey({ q: params?.q, sort: params?.sort });

const toDisplayContexts = (response: ContextListResponse): DisplayContextMemory[] =>
  response.items.map(
    (item) =>
      ({ ...item.memory, ...item.context, source: null }) as unknown as DisplayContextMemory,
  );

type Setter = StoreSetter<UserMemoryStore>;
export const createContextSlice = (set: Setter, get: () => UserMemoryStore, _api?: unknown) =>
  new ContextActionImpl(set, get, _api);

export class ContextActionImpl {
  readonly #get: () => UserMemoryStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => UserMemoryStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  deleteContext = async (id: string): Promise<void> => {
    await memoryCRUDService.deleteContext(id);
    await this.refreshContextsList();
  };

  loadMoreContexts = (): void => {
    const {
      contexts,
      contextsHasMore,
      contextsPage,
      contextsPageError,
      contextsPendingPage,
      contextsSearchLoading,
      contextsTotal,
    } = this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for the next page of the
    // new query and append it to those rows, leaving the list permanently mixed
    // and the new query's page 1 missing.
    if (contextsSearchLoading || !contextsHasMore) return;

    // One page request at a time. Remounting the virtualizer (a grid <-> timeline
    // switch, say) lands the viewport at the end again and fires `endReached` a
    // second time; without this latch that skipped straight to page 3, and page 2
    // — rejected by the page guard when it finally landed — was lost for good.
    if (contextsPendingPage !== undefined) return;

    // A failed page is retried explicitly (see `retryContextsPage`), never by
    // silently asking for the page after it.
    if (contextsPageError) return;

    if (contexts.length >= (contextsTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.contextsPage = contextsPage + 1;
        draft.contextsPendingPage = contextsPage + 1;
      }),
      false,
      n('loadMoreContexts'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetContextsList` (a no-op on
   * an unchanged query) nor a key change can drive it. Rewind to page 1, drop
   * every cached page of the list, then fetch page 1 here rather than hoping a
   * subscriber revalidates — the store's page and React's subscription move at
   * different times, so "revalidate whatever is subscribed" refreshes the page
   * the user happens to be on, not the one the store is about to render.
   *
   * Public because every write path has to come through here: the memory editor
   * lives in the base slice and used to invalidate with a bare matcher `mutate`,
   * which left the edited row sitting in the accumulated pages.
   */
  refreshContextsList = async (): Promise<void> => {
    const state = this.#get();
    const params: ContextQueryParams = {
      page: 1,
      pageSize: state.contextsPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.contextsQuery,
      sort: state.contextsSort,
    };

    // Every in-flight request for this list is now stale, and they cannot be
    // told apart by key and page alone — two overlapping refreshes of the same
    // query both look like "page 1 of this query". The generation is what
    // separates them, so the older one is dropped even if it lands last. The
    // query identity does not change here, which is exactly why the counter
    // has to move.
    const generation = state.contextsGeneration + 1;

    this.#set(
      produce((draft) => {
        draft.contextsError = undefined;
        draft.contextsGeneration = generation;
        draft.contextsHasMore = false;
        draft.contextsPage = 1;
        draft.contextsPageError = undefined;
        draft.contextsPendingPage = undefined;
        draft.contextsSearchLoading = true;
        draft.contextsSettled = false;
      }),
      false,
      n('refreshContextsList'),
    );

    await dropMemoryListCache(userMemoryKeys.contexts.root);

    try {
      const data = (await userMemoryService.queryMemories({
        layer: LayersEnum.Context,
        ...params,
      })) as ContextListResponse;
      this.#applyContextsPage(params, data, generation);
    } catch (error) {
      this.#failContextsPage(params, error, generation);
    }
  };

  resetContextsList = (params?: ContextFilter): void => {
    const state = this.#get();
    const nextQueryKey = contextQueryKey(params);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped the
    // rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.contextsQueryKey && state.contextsSettled) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `contexts`: the rows already on screen stay put while
        // the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.contextsError = undefined;
        // The generation counts invalidations *within* one query identity, so
        // it restarts when the identity itself changes. The pair (query key,
        // generation) is what a response is matched against; a reset always
        // moves it, either by changing the key or — on a same-key retry — by
        // stepping the counter past whatever the failed attempt left in flight.
        draft.contextsGeneration =
          nextQueryKey === state.contextsQueryKey ? state.contextsGeneration + 1 : 0;
        draft.contextsHasMore = false;
        draft.contextsPage = 1;
        draft.contextsPageError = undefined;
        draft.contextsPendingPage = undefined;
        draft.contextsQueryKey = nextQueryKey;
        draft.contextsQuery = params?.q;
        draft.contextsSort = params?.sort;
        draft.contextsSearchLoading = true;
        draft.contextsSettled = false;
      }),
      false,
      n('resetContextsList'),
    );
  };

  /**
   * Retry the page that failed, not the one after it.
   *
   * The page renders a retryable footer for a pagination failure; the component
   * revalidates the SWR key it is already on, which is exactly the failed page
   * because `contextsPage` was never advanced past it.
   */
  retryContextsPage = (): void => {
    const { contextsPage, contextsPageError } = this.#get();
    if (!contextsPageError) return;

    this.#set(
      produce((draft) => {
        draft.contextsPageError = undefined;
        draft.contextsPendingPage = contextsPage;
      }),
      false,
      n('retryContextsPage'),
    );
  };

  useFetchContexts = (params: ContextQueryParams): SWRResponse<ContextListResponse> => {
    const queryKey = contextQueryKey(params);
    const page = params.page ?? 1;

    const swr = useSWR<ContextListResponse>(
      userMemoryKeys.contexts(params),
      async () => {
        // Captured before the request, never read back after it: that is what
        // lets a response which was already in flight when a write evicted the
        // list be told apart from a fresh one.
        const generation = this.#get().contextsGeneration;

        try {
          const data = (await userMemoryService.queryMemories({
            layer: LayersEnum.Context,
            page: params.page,
            pageSize: params.pageSize,
            q: params.q,
            sort: params.sort,
          })) as ContextListResponse;
          this.#applyContextsPage(params, data, generation);
          return data;
        } catch (error) {
          this.#failContextsPage(params, error, generation);
          throw error;
        }
      },
      { revalidateOnFocus: false },
    );

    // Bootstrap from the cache. When the key changes to a page SWR has already
    // fetched it hands the data back without ever running the fetcher above, so
    // applying only in the fetcher would leave the previous query's rows on
    // screen under a spinner that never stops. This path is limited to a page
    // the store is still waiting for (see `#applyContextsPage`), so it can never
    // overwrite rows that have already settled.
    const data = swr.data;
    useEffect(() => {
      if (!data) return;
      this.#applyContextsPage(params, data);
    }, [data, queryKey, page]);

    return swr;
  };

  /**
   * Write one page into the list.
   *
   * Three things have to line up: the query identity, the page the store is
   * waiting for, and — for a response produced by a request we started
   * ourselves — the generation that request captured.
   */
  #applyContextsPage = (
    params: ContextQueryParams,
    data: ContextListResponse,
    generation?: number,
  ): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (contextQueryKey(params) !== state.contextsQueryKey) return;
    if (page !== state.contextsPage) return;

    if (generation === undefined) {
      // Cache bootstrap: only a page the store has not resolved yet. Everything
      // else is applied by the fetcher under its own generation, so a stale
      // in-flight response cannot clobber the rows a write just produced.
      if (state.contextsSettled && state.contextsPendingPage !== page) return;
    } else if (generation !== state.contextsGeneration) return;

    const items = toDisplayContexts(data);

    this.#set(
      produce((draft) => {
        draft.contextsError = undefined;
        draft.contextsHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.contextsPageError = undefined;
        draft.contextsPageSize = params.pageSize ?? draft.contextsPageSize;
        draft.contextsPendingPage = undefined;
        draft.contextsSearchLoading = false;
        draft.contextsSettled = true;
        draft.contextsTotal = data.total;
        draft.contexts =
          page === 1 ? uniqBy(items, 'id') : uniqBy([...draft.contexts, ...items], 'id');
      }),
      false,
      n('applyContextsPage'),
    );
  };

  /**
   * Record a failure.
   *
   * A first page that never landed is a whole-list failure, which the page
   * renders instead of the list. A later page is a pagination failure, which
   * keeps the rows on screen and offers a retryable footer — collapsing the two
   * hid every load-more failure behind a footer that simply stopped.
   */
  #failContextsPage = (params: ContextQueryParams, error: unknown, generation: number): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (contextQueryKey(params) !== state.contextsQueryKey) return;
    if (page !== state.contextsPage) return;
    if (generation !== state.contextsGeneration) return;

    this.#set(
      produce((draft) => {
        draft.contextsPendingPage = undefined;

        if (page > 1) {
          draft.contextsPageError = error;
          return;
        }

        draft.contextsError = error;
        draft.contextsSearchLoading = false;
      }),
      false,
      n('failContextsPage'),
    );
  };
}

export type ContextAction = Pick<ContextActionImpl, keyof ContextActionImpl>;

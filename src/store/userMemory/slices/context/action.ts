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

/** Every filter field of `ContextQueryParams` — pagination excluded. */
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
    await this.#refreshContextsList();
  };

  loadMoreContexts = (): void => {
    const { contexts, contextsHasMore, contextsPage, contextsSearchLoading, contextsTotal } =
      this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for page 2 of the new
    // query and append it to those rows, leaving the list permanently mixed and
    // page 1 of the new query missing. `hasMore` is also latched false across a
    // reset, which stops the virtualized `endReached` from firing at all.
    if (contextsSearchLoading || !contextsHasMore) return;
    if (contexts.length >= (contextsTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.contextsPage = contextsPage + 1;
      }),
      false,
      n('loadMoreContexts'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetContextsList` (a
   * no-op on an unchanged query) nor a key change can drive it. Rewind to page
   * 1, drop every cached page of the list, then fetch page 1 here rather than
   * hoping a subscriber revalidates — the store's page and React's subscription
   * move at different times, so "revalidate whatever is subscribed" would have
   * refreshed the page the user happened to be on, not the one the store is
   * about to render.
   */
  #refreshContextsList = async (): Promise<void> => {
    const state = this.#get();
    const params: ContextQueryParams = {
      page: 1,
      pageSize: state.contextsPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.contextsQuery,
      sort: state.contextsSort,
    };

    this.#set(
      produce((draft) => {
        draft.contextsError = undefined;
        draft.contextsHasMore = false;
        draft.contextsPage = 1;
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
      this.#applyContextsPage(params, data);
    } catch (error) {
      this.#failContextsPage(params, error);
    }
  };

  resetContextsList = (params?: ContextFilter): void => {
    const state = this.#get();
    const nextQueryKey = contextQueryKey(params);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped
    // the rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.contextsQueryKey && state.contextsSettled) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `contexts`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.contextsError = undefined;
        draft.contextsHasMore = false;
        draft.contextsPage = 1;
        draft.contextsQuery = params?.q;
        draft.contextsQueryKey = nextQueryKey;
        draft.contextsSearchLoading = true;
        draft.contextsSettled = false;
        draft.contextsSort = params?.sort;
      }),
      false,
      n('resetContextsList'),
    );
  };

  useFetchContexts = (params: ContextQueryParams): SWRResponse<ContextListResponse> => {
    const queryKey = contextQueryKey(params);
    const page = params.page ?? 1;

    const swr = useSWR<ContextListResponse>(
      userMemoryKeys.contexts(params),
      async () => {
        const result = await userMemoryService.queryMemories({
          layer: LayersEnum.Context,
          page: params.page,
          pageSize: params.pageSize,
          q: params.q,
          sort: params.sort,
        });

        return result as ContextListResponse;
      },
      {
        onError: (error) => this.#failContextsPage(params, error),
        revalidateOnFocus: false,
      },
    );

    // Sync SWR → store from an effect rather than `onSuccess`: when the key
    // changes to a page that is already cached, SWR hands the data back without
    // ever running the fetcher, and an `onSuccess`-only store would keep
    // showing the previous query's rows with a spinner that never stops.
    const data = swr.data;
    useEffect(() => {
      if (!data) return;
      this.#applyContextsPage(params, data);
    }, [data, queryKey, page]);

    return swr;
  };

  /** Write one page into the list — only if it still belongs to what's on screen. */
  #applyContextsPage = (params: ContextQueryParams, data: ContextListResponse): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (contextQueryKey(params) !== state.contextsQueryKey) return;
    if (page !== state.contextsPage) return;

    const items = toDisplayContexts(data);

    this.#set(
      produce((draft) => {
        draft.contextsError = undefined;
        draft.contextsHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.contextsPageSize = params.pageSize ?? draft.contextsPageSize;
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

  /** Record a failure for the query on screen so the page can offer a retry. */
  #failContextsPage = (params: ContextQueryParams, error: unknown): void => {
    if (contextQueryKey(params) !== this.#get().contextsQueryKey) return;

    this.#set(
      produce((draft) => {
        draft.contextsError = error;
        draft.contextsSearchLoading = false;
      }),
      false,
      n('failContextsPage'),
    );
  };
}

export type ContextAction = Pick<ContextActionImpl, keyof ContextActionImpl>;

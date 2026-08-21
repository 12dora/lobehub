import {
  type IdentityListResult,
  type NewUserMemoryIdentity,
  type UpdateUserMemoryIdentity,
} from '@lobechat/types';
import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { useEffect } from 'react';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { type AddIdentityEntryResult } from '@/database/models/userMemory';
import { userMemoryKeys } from '@/libs/swr/keys';
import { memoryCRUDService, userMemoryService } from '@/services/userMemory';
import { type StoreSetter } from '@/store/types';
import { setNamespace } from '@/utils/storeDebug';

import { type UserMemoryStore } from '../../store';
import { DEFAULT_MEMORY_LIST_PAGE_SIZE, memoryListQueryKey } from '../../utils/listQuery';
import { dropMemoryListCache } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/identity');

export interface IdentityQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  relationships?: string[];
  sort?: 'capturedAt' | 'type';
  types?: string[];
}

type IdentityFilter = Omit<IdentityQueryParams, 'page' | 'pageSize'>;

/**
 * Every filter field of `IdentityQueryParams` — pagination excluded.
 */
const identityQueryKey = (params?: IdentityFilter): string =>
  memoryListQueryKey({
    q: params?.q,
    relationships: params?.relationships,
    sort: params?.sort,
    types: params?.types,
  });

type Setter = StoreSetter<UserMemoryStore>;
export const createIdentitySlice = (set: Setter, get: () => UserMemoryStore, _api?: unknown) =>
  new IdentityActionImpl(set, get, _api);

export class IdentityActionImpl {
  readonly #get: () => UserMemoryStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => UserMemoryStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  createIdentity = async (data: NewUserMemoryIdentity): Promise<AddIdentityEntryResult> => {
    const result = await memoryCRUDService.createIdentity(data);
    await this.refreshIdentitiesList();
    return result;
  };

  deleteIdentity = async (id: string): Promise<void> => {
    await memoryCRUDService.deleteIdentity(id);
    await this.refreshIdentitiesList();
  };

  updateIdentity = async (id: string, data: UpdateUserMemoryIdentity): Promise<boolean> => {
    const result = await memoryCRUDService.updateIdentity(id, data);
    await this.refreshIdentitiesList();
    return result;
  };

  loadMoreIdentities = (): void => {
    const {
      identities,
      identitiesHasMore,
      identitiesPage,
      identitiesPageError,
      identitiesPendingPage,
      identitiesSearchLoading,
      identitiesTotal,
    } = this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for the next page of the
    // new query and append it to those rows, leaving the list permanently mixed
    // and the new query's page 1 missing.
    if (identitiesSearchLoading || !identitiesHasMore) return;

    // One page request at a time. Remounting the virtualizer (a grid <-> timeline
    // switch, say) lands the viewport at the end again and fires `endReached` a
    // second time; without this latch that skipped straight to page 3, and page 2
    // — rejected by the page guard when it finally landed — was lost for good.
    if (identitiesPendingPage !== undefined) return;

    // A failed page is retried explicitly (see `retryIdentitiesPage`), never by
    // silently asking for the page after it.
    if (identitiesPageError) return;

    if (identities.length >= (identitiesTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.identitiesPage = identitiesPage + 1;
        draft.identitiesPendingPage = identitiesPage + 1;
      }),
      false,
      n('loadMoreIdentities'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetIdentitiesList` (a no-op on
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
  refreshIdentitiesList = async (): Promise<void> => {
    const state = this.#get();
    const params: IdentityQueryParams = {
      page: 1,
      pageSize: state.identitiesPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.identitiesQuery,
      relationships: state.identitiesRelationships,
      sort: state.identitiesSort,
      types: state.identitiesTypes,
    };

    // Every in-flight request for this list is now stale, and they cannot be
    // told apart by key and page alone — two overlapping refreshes of the same
    // query both look like "page 1 of this query". The generation is what
    // separates them, so the older one is dropped even if it lands last. The
    // query identity does not change here, which is exactly why the counter
    // has to move.
    const generation = state.identitiesGeneration + 1;

    this.#set(
      produce((draft) => {
        draft.identitiesError = undefined;
        draft.identitiesGeneration = generation;
        draft.identitiesHasMore = false;
        draft.identitiesPage = 1;
        draft.identitiesPageError = undefined;
        draft.identitiesPendingPage = undefined;
        draft.identitiesSearchLoading = true;
        draft.identitiesSettled = false;
      }),
      false,
      n('refreshIdentitiesList'),
    );

    await dropMemoryListCache(userMemoryKeys.identityList.root);

    try {
      const data = await userMemoryService.queryIdentities(params);
      this.#applyIdentitiesPage(params, data, generation);
    } catch (error) {
      this.#failIdentitiesPage(params, error, generation);
    }
  };

  resetIdentitiesList = (params?: IdentityFilter): void => {
    const state = this.#get();
    const nextQueryKey = identityQueryKey(params);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped the
    // rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.identitiesQueryKey && state.identitiesSettled) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `identities`: the rows already on screen stay put while
        // the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.identitiesError = undefined;
        // The generation counts invalidations *within* one query identity, so
        // it restarts when the identity itself changes. The pair (query key,
        // generation) is what a response is matched against; a reset always
        // moves it, either by changing the key or — on a same-key retry — by
        // stepping the counter past whatever the failed attempt left in flight.
        draft.identitiesGeneration =
          nextQueryKey === state.identitiesQueryKey ? state.identitiesGeneration + 1 : 0;
        draft.identitiesHasMore = false;
        draft.identitiesPage = 1;
        draft.identitiesPageError = undefined;
        draft.identitiesPendingPage = undefined;
        draft.identitiesQueryKey = nextQueryKey;
        draft.identitiesQuery = params?.q;
        draft.identitiesRelationships = params?.relationships;
        draft.identitiesSort = params?.sort;
        draft.identitiesTypes = params?.types;
        draft.identitiesSearchLoading = true;
        draft.identitiesSettled = false;
      }),
      false,
      n('resetIdentitiesList'),
    );
  };

  /**
   * Retry the page that failed, not the one after it.
   *
   * The page renders a retryable footer for a pagination failure; the component
   * revalidates the SWR key it is already on, which is exactly the failed page
   * because `identitiesPage` was never advanced past it.
   */
  retryIdentitiesPage = (): void => {
    const { identitiesPage, identitiesPageError } = this.#get();
    if (!identitiesPageError) return;

    this.#set(
      produce((draft) => {
        draft.identitiesPageError = undefined;
        draft.identitiesPendingPage = identitiesPage;
      }),
      false,
      n('retryIdentitiesPage'),
    );
  };

  useFetchIdentities = (params: IdentityQueryParams): SWRResponse<IdentityListResult> => {
    const queryKey = identityQueryKey(params);
    const page = params.page ?? 1;

    const swr = useSWR<IdentityListResult>(
      userMemoryKeys.identityList(params),
      async () => {
        // Captured before the request, never read back after it: that is what
        // lets a response which was already in flight when a write evicted the
        // list be told apart from a fresh one.
        const generation = this.#get().identitiesGeneration;

        try {
          const data = await userMemoryService.queryIdentities({
            page: params.page,
            pageSize: params.pageSize,
            q: params.q,
            relationships: params.relationships,
            sort: params.sort,
            types: params.types,
          });
          this.#applyIdentitiesPage(params, data, generation);
          return data;
        } catch (error) {
          this.#failIdentitiesPage(params, error, generation);
          throw error;
        }
      },
      { revalidateOnFocus: false },
    );

    // Bootstrap from the cache. When the key changes to a page SWR has already
    // fetched it hands the data back without ever running the fetcher above, so
    // applying only in the fetcher would leave the previous query's rows on
    // screen under a spinner that never stops. This path is limited to a page
    // the store is still waiting for (see `#applyIdentitiesPage`), so it can never
    // overwrite rows that have already settled.
    const data = swr.data;
    useEffect(() => {
      if (!data) return;
      this.#applyIdentitiesPage(params, data);
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
  #applyIdentitiesPage = (
    params: IdentityQueryParams,
    data: IdentityListResult,
    generation?: number,
  ): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (identityQueryKey(params) !== state.identitiesQueryKey) return;
    if (page !== state.identitiesPage) return;

    if (generation === undefined) {
      // Cache bootstrap: only a page the store has not resolved yet. Everything
      // else is applied by the fetcher under its own generation, so a stale
      // in-flight response cannot clobber the rows a write just produced.
      if (state.identitiesSettled && state.identitiesPendingPage !== page) return;
    } else if (generation !== state.identitiesGeneration) return;

    // Backend returns a flat structure directly, no transformation needed.
    const items = data.items;

    this.#set(
      produce((draft) => {
        draft.identitiesError = undefined;
        draft.identitiesHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.identitiesPageError = undefined;
        draft.identitiesPageSize = params.pageSize ?? draft.identitiesPageSize;
        draft.identitiesPendingPage = undefined;
        draft.identitiesSearchLoading = false;
        draft.identitiesSettled = true;
        draft.identitiesTotal = data.total;
        draft.identities =
          page === 1 ? uniqBy(items, 'id') : uniqBy([...draft.identities, ...items], 'id');
      }),
      false,
      n('applyIdentitiesPage'),
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
  #failIdentitiesPage = (params: IdentityQueryParams, error: unknown, generation: number): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (identityQueryKey(params) !== state.identitiesQueryKey) return;
    if (page !== state.identitiesPage) return;
    if (generation !== state.identitiesGeneration) return;

    this.#set(
      produce((draft) => {
        draft.identitiesPendingPage = undefined;

        if (page > 1) {
          draft.identitiesPageError = error;
          return;
        }

        draft.identitiesError = error;
        draft.identitiesSearchLoading = false;
      }),
      false,
      n('failIdentitiesPage'),
    );
  };
}

export type IdentityAction = Pick<IdentityActionImpl, keyof IdentityActionImpl>;

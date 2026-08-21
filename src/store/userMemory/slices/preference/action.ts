import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { useEffect } from 'react';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { type DisplayPreferenceMemory } from '@/database/repositories/userMemory';
import { userMemoryKeys } from '@/libs/swr/keys';
import { memoryCRUDService, userMemoryService } from '@/services/userMemory';
import { type StoreSetter } from '@/store/types';
import { LayersEnum } from '@/types/userMemory';
import { setNamespace } from '@/utils/storeDebug';

import { type UserMemoryStore } from '../../store';
import { DEFAULT_MEMORY_LIST_PAGE_SIZE, memoryListQueryKey } from '../../utils/listQuery';
import { dropMemoryListCache } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/preference');

export interface PreferenceQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'capturedAt' | 'scorePriority';
}

type PreferenceFilter = Omit<PreferenceQueryParams, 'page' | 'pageSize'>;

interface PreferenceListResponse {
  items: { memory?: Record<string, unknown>; preference?: Record<string, unknown> }[];
  total: number;
}

/**
 * Every filter field of `PreferenceQueryParams` — pagination excluded.
 */
const preferenceQueryKey = (params?: PreferenceFilter): string =>
  memoryListQueryKey({ q: params?.q, sort: params?.sort });

const toDisplayPreferences = (response: PreferenceListResponse): DisplayPreferenceMemory[] =>
  response.items.map(
    (item) => ({ ...item.memory, ...item.preference }) as unknown as DisplayPreferenceMemory,
  );

type Setter = StoreSetter<UserMemoryStore>;
export const createPreferenceSlice = (set: Setter, get: () => UserMemoryStore, _api?: unknown) =>
  new PreferenceActionImpl(set, get, _api);

export class PreferenceActionImpl {
  readonly #get: () => UserMemoryStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => UserMemoryStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  deletePreference = async (id: string): Promise<void> => {
    await memoryCRUDService.deletePreference(id);
    await this.refreshPreferencesList();
  };

  loadMorePreferences = (): void => {
    const {
      preferences,
      preferencesHasMore,
      preferencesPage,
      preferencesPageError,
      preferencesPendingPage,
      preferencesSearchLoading,
      preferencesTotal,
    } = this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for the next page of the
    // new query and append it to those rows, leaving the list permanently mixed
    // and the new query's page 1 missing.
    if (preferencesSearchLoading || !preferencesHasMore) return;

    // One page request at a time. Remounting the virtualizer (a grid <-> timeline
    // switch, say) lands the viewport at the end again and fires `endReached` a
    // second time; without this latch that skipped straight to page 3, and page 2
    // — rejected by the page guard when it finally landed — was lost for good.
    if (preferencesPendingPage !== undefined) return;

    // A failed page is retried explicitly (see `retryPreferencesPage`), never by
    // silently asking for the page after it.
    if (preferencesPageError) return;

    if (preferences.length >= (preferencesTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.preferencesPage = preferencesPage + 1;
        draft.preferencesPendingPage = preferencesPage + 1;
      }),
      false,
      n('loadMorePreferences'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetPreferencesList` (a no-op on
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
  refreshPreferencesList = async (): Promise<void> => {
    const state = this.#get();
    const params: PreferenceQueryParams = {
      page: 1,
      pageSize: state.preferencesPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.preferencesQuery,
      sort: state.preferencesSort,
    };

    // Every in-flight request for this list is now stale, and they cannot be
    // told apart by key and page alone — two overlapping refreshes of the same
    // query both look like "page 1 of this query". The generation is what
    // separates them, so the older one is dropped even if it lands last. The
    // query identity does not change here, which is exactly why the counter
    // has to move.
    const generation = state.preferencesGeneration + 1;

    this.#set(
      produce((draft) => {
        draft.preferencesError = undefined;
        draft.preferencesGeneration = generation;
        draft.preferencesHasMore = false;
        draft.preferencesPage = 1;
        draft.preferencesPageError = undefined;
        draft.preferencesPendingPage = undefined;
        draft.preferencesSearchLoading = true;
        draft.preferencesSettled = false;
      }),
      false,
      n('refreshPreferencesList'),
    );

    await dropMemoryListCache(userMemoryKeys.preferences.root);

    try {
      const data = (await userMemoryService.queryMemories({
        layer: LayersEnum.Preference,
        ...params,
      })) as PreferenceListResponse;
      this.#applyPreferencesPage(params, data, generation);
    } catch (error) {
      this.#failPreferencesPage(params, error, generation);
    }
  };

  resetPreferencesList = (params?: PreferenceFilter): void => {
    const state = this.#get();
    const nextQueryKey = preferenceQueryKey(params);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped the
    // rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.preferencesQueryKey && state.preferencesSettled) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `preferences`: the rows already on screen stay put while
        // the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.preferencesError = undefined;
        // The generation counts invalidations *within* one query identity, so
        // it restarts when the identity itself changes. The pair (query key,
        // generation) is what a response is matched against; a reset always
        // moves it, either by changing the key or — on a same-key retry — by
        // stepping the counter past whatever the failed attempt left in flight.
        draft.preferencesGeneration =
          nextQueryKey === state.preferencesQueryKey ? state.preferencesGeneration + 1 : 0;
        draft.preferencesHasMore = false;
        draft.preferencesPage = 1;
        draft.preferencesPageError = undefined;
        draft.preferencesPendingPage = undefined;
        draft.preferencesQueryKey = nextQueryKey;
        draft.preferencesQuery = params?.q;
        draft.preferencesSort = params?.sort;
        draft.preferencesSearchLoading = true;
        draft.preferencesSettled = false;
      }),
      false,
      n('resetPreferencesList'),
    );
  };

  /**
   * Retry the page that failed, not the one after it.
   *
   * The page renders a retryable footer for a pagination failure; the component
   * revalidates the SWR key it is already on, which is exactly the failed page
   * because `preferencesPage` was never advanced past it.
   */
  retryPreferencesPage = (): void => {
    const { preferencesPage, preferencesPageError } = this.#get();
    if (!preferencesPageError) return;

    this.#set(
      produce((draft) => {
        draft.preferencesPageError = undefined;
        draft.preferencesPendingPage = preferencesPage;
      }),
      false,
      n('retryPreferencesPage'),
    );
  };

  useFetchPreferences = (params: PreferenceQueryParams): SWRResponse<PreferenceListResponse> => {
    const queryKey = preferenceQueryKey(params);
    const page = params.page ?? 1;

    const swr = useSWR<PreferenceListResponse>(
      userMemoryKeys.preferences(params),
      async () => {
        // Captured before the request, never read back after it: that is what
        // lets a response which was already in flight when a write evicted the
        // list be told apart from a fresh one.
        const generation = this.#get().preferencesGeneration;

        try {
          const data = (await userMemoryService.queryMemories({
            layer: LayersEnum.Preference,
            page: params.page,
            pageSize: params.pageSize,
            q: params.q,
            sort: params.sort,
          })) as PreferenceListResponse;
          this.#applyPreferencesPage(params, data, generation);
          return data;
        } catch (error) {
          this.#failPreferencesPage(params, error, generation);
          throw error;
        }
      },
      { revalidateOnFocus: false },
    );

    // Bootstrap from the cache. When the key changes to a page SWR has already
    // fetched it hands the data back without ever running the fetcher above, so
    // applying only in the fetcher would leave the previous query's rows on
    // screen under a spinner that never stops. This path is limited to a page
    // the store is still waiting for (see `#applyPreferencesPage`), so it can never
    // overwrite rows that have already settled.
    const data = swr.data;
    useEffect(() => {
      if (!data) return;
      this.#applyPreferencesPage(params, data);
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
  #applyPreferencesPage = (
    params: PreferenceQueryParams,
    data: PreferenceListResponse,
    generation?: number,
  ): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (preferenceQueryKey(params) !== state.preferencesQueryKey) return;
    if (page !== state.preferencesPage) return;

    if (generation === undefined) {
      // Cache bootstrap: only a page the store has not resolved yet. Everything
      // else is applied by the fetcher under its own generation, so a stale
      // in-flight response cannot clobber the rows a write just produced.
      if (state.preferencesSettled && state.preferencesPendingPage !== page) return;
    } else if (generation !== state.preferencesGeneration) return;

    const items = toDisplayPreferences(data);

    this.#set(
      produce((draft) => {
        draft.preferencesError = undefined;
        draft.preferencesHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.preferencesPageError = undefined;
        draft.preferencesPageSize = params.pageSize ?? draft.preferencesPageSize;
        draft.preferencesPendingPage = undefined;
        draft.preferencesSearchLoading = false;
        draft.preferencesSettled = true;
        draft.preferencesTotal = data.total;
        draft.preferences =
          page === 1 ? uniqBy(items, 'id') : uniqBy([...draft.preferences, ...items], 'id');
      }),
      false,
      n('applyPreferencesPage'),
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
  #failPreferencesPage = (
    params: PreferenceQueryParams,
    error: unknown,
    generation: number,
  ): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (preferenceQueryKey(params) !== state.preferencesQueryKey) return;
    if (page !== state.preferencesPage) return;
    if (generation !== state.preferencesGeneration) return;

    this.#set(
      produce((draft) => {
        draft.preferencesPendingPage = undefined;

        if (page > 1) {
          draft.preferencesPageError = error;
          return;
        }

        draft.preferencesError = error;
        draft.preferencesSearchLoading = false;
      }),
      false,
      n('failPreferencesPage'),
    );
  };
}

export type PreferenceAction = Pick<PreferenceActionImpl, keyof PreferenceActionImpl>;

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

/** Every filter field of `PreferenceQueryParams` — pagination excluded. */
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
    await this.#refreshPreferencesList();
  };

  loadMorePreferences = (): void => {
    const {
      preferences,
      preferencesHasMore,
      preferencesPage,
      preferencesSearchLoading,
      preferencesTotal,
    } = this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for page 2 of the new
    // query and append it to those rows, leaving the list permanently mixed and
    // page 1 of the new query missing. `hasMore` is also latched false across a
    // reset, which stops the virtualized `endReached` from firing at all.
    if (preferencesSearchLoading || !preferencesHasMore) return;
    if (preferences.length >= (preferencesTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.preferencesPage = preferencesPage + 1;
      }),
      false,
      n('loadMorePreferences'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetPreferencesList` (a
   * no-op on an unchanged query) nor a key change can drive it. Rewind to page
   * 1, drop every cached page of the list, then fetch page 1 here rather than
   * hoping a subscriber revalidates — the store's page and React's subscription
   * move at different times, so "revalidate whatever is subscribed" would have
   * refreshed the page the user happened to be on, not the one the store is
   * about to render.
   */
  #refreshPreferencesList = async (): Promise<void> => {
    const state = this.#get();
    const params: PreferenceQueryParams = {
      page: 1,
      pageSize: state.preferencesPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.preferencesQuery,
      sort: state.preferencesSort,
    };

    this.#set(
      produce((draft) => {
        draft.preferencesError = undefined;
        draft.preferencesHasMore = false;
        draft.preferencesPage = 1;
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
      this.#applyPreferencesPage(params, data);
    } catch (error) {
      this.#failPreferencesPage(params, error);
    }
  };

  resetPreferencesList = (params?: PreferenceFilter): void => {
    const state = this.#get();
    const nextQueryKey = preferenceQueryKey(params);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped
    // the rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.preferencesQueryKey && state.preferencesSettled) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `preferences`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.preferencesError = undefined;
        draft.preferencesHasMore = false;
        draft.preferencesPage = 1;
        draft.preferencesQuery = params?.q;
        draft.preferencesQueryKey = nextQueryKey;
        draft.preferencesSearchLoading = true;
        draft.preferencesSettled = false;
        draft.preferencesSort = params?.sort;
      }),
      false,
      n('resetPreferencesList'),
    );
  };

  useFetchPreferences = (params: PreferenceQueryParams): SWRResponse<PreferenceListResponse> => {
    const queryKey = preferenceQueryKey(params);
    const page = params.page ?? 1;

    const swr = useSWR<PreferenceListResponse>(
      userMemoryKeys.preferences(params),
      async () => {
        const result = await userMemoryService.queryMemories({
          layer: LayersEnum.Preference,
          page: params.page,
          pageSize: params.pageSize,
          q: params.q,
          sort: params.sort,
        });

        return result as PreferenceListResponse;
      },
      {
        onError: (error) => this.#failPreferencesPage(params, error),
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
      this.#applyPreferencesPage(params, data);
    }, [data, queryKey, page]);

    return swr;
  };

  /** Write one page into the list — only if it still belongs to what's on screen. */
  #applyPreferencesPage = (params: PreferenceQueryParams, data: PreferenceListResponse): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (preferenceQueryKey(params) !== state.preferencesQueryKey) return;
    if (page !== state.preferencesPage) return;

    const items = toDisplayPreferences(data);

    this.#set(
      produce((draft) => {
        draft.preferencesError = undefined;
        draft.preferencesHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.preferencesPageSize = params.pageSize ?? draft.preferencesPageSize;
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

  /** Record a failure for the query on screen so the page can offer a retry. */
  #failPreferencesPage = (params: PreferenceQueryParams, error: unknown): void => {
    if (preferenceQueryKey(params) !== this.#get().preferencesQueryKey) return;

    this.#set(
      produce((draft) => {
        draft.preferencesError = error;
        draft.preferencesSearchLoading = false;
      }),
      false,
      n('failPreferencesPage'),
    );
  };
}

export type PreferenceAction = Pick<PreferenceActionImpl, keyof PreferenceActionImpl>;

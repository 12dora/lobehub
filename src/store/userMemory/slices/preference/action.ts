import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { type DisplayPreferenceMemory } from '@/database/repositories/userMemory';
import { userMemoryKeys } from '@/libs/swr/keys';
import { memoryCRUDService, userMemoryService } from '@/services/userMemory';
import { type StoreSetter } from '@/store/types';
import { LayersEnum } from '@/types/userMemory';
import { setNamespace } from '@/utils/storeDebug';

import { type UserMemoryStore } from '../../store';
import { revalidateMemoryList } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/preference');

export interface PreferenceQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'capturedAt' | 'scorePriority';
}

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
    const { preferencesPage, preferencesTotal, preferences } = this.#get();
    if (preferences.length < (preferencesTotal || 0)) {
      this.#set(
        produce((draft) => {
          draft.preferencesPage = preferencesPage + 1;
        }),
        false,
        n('loadMorePreferences'),
      );
    }
  };

  /**
   * Force a re-read of the list after a write.
   *
   * A mutation doesn't change the query, so it can't go through
   * `resetPreferencesList` (which now no-ops on an unchanged query) and it can't
   * rely on the SWR key changing either. Rewind to page 1 so the accumulated
   * pages can't resurrect a row that was just removed, then revalidate.
   */
  #refreshPreferencesList = async (): Promise<void> => {
    this.#set(
      produce((draft) => {
        draft.preferencesPage = 1;
        draft.preferencesSearchLoading = true;
      }),
      false,
      n('refreshPreferencesList'),
    );

    await revalidateMemoryList(userMemoryKeys.preferences.root);
  };

  resetPreferencesList = (params?: Omit<PreferenceQueryParams, 'page' | 'pageSize'>): void => {
    const state = this.#get();

    // Nothing to reset when the query is the one the store already fetched.
    // The pages call this from a mount effect, so without this guard every
    // visit wiped the rows it had and replaced the list with a skeleton.
    const isSameQuery =
      state.preferencesQuery === params?.q && state.preferencesSort === params?.sort;

    if (isSameQuery && state.preferencesInit) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `preferences`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton), and the page-1 response below
        // replaces them wholesale.
        draft.preferencesPage = 1;
        draft.preferencesQuery = params?.q;
        draft.preferencesSearchLoading = true;
        draft.preferencesSort = params?.sort;
      }),
      false,
      n('resetPreferencesList'),
    );
  };

  useFetchPreferences = (params: PreferenceQueryParams): SWRResponse<any> => {
    const page = params.page ?? 1;

    return useSWR(
      userMemoryKeys.preferences(params),
      async () => {
        const result = await userMemoryService.queryMemories({
          layer: LayersEnum.Preference,
          page: params.page,
          pageSize: params.pageSize,
          q: params.q,
          sort: params.sort,
        });

        return result;
      },
      {
        onError: () => {
          // Otherwise the refreshing affordance would spin forever on a failed
          // revalidation.
          this.#set(
            produce((draft) => {
              draft.preferencesSearchLoading = false;
            }),
            false,
            n('useFetchPreferences/onError'),
          );
        },
        onSuccess: (data: any) => {
          this.#set(
            produce((draft) => {
              draft.preferencesSearchLoading = false;

              // Set basic information
              if (!draft.preferencesInit) {
                draft.preferencesInit = true;
                draft.preferencesTotal = data.total;
              }

              // Transform data structure
              const transformedItems: DisplayPreferenceMemory[] = data.items.map((item: any) => ({
                ...item.memory,
                ...item.preference,
              }));

              // Accumulate data logic
              if (page === 1) {
                // First page, set directly
                draft.preferences = uniqBy(transformedItems, 'id');
              } else {
                // Subsequent pages, accumulate data
                draft.preferences = uniqBy([...draft.preferences, ...transformedItems], 'id');
              }

              // Update hasMore
              draft.preferencesHasMore = data.items.length >= (params.pageSize || 20);
            }),
            false,
            n('useFetchPreferences/onSuccess'),
          );
        },
        revalidateOnFocus: false,
      },
    );
  };
}

export type PreferenceAction = Pick<PreferenceActionImpl, keyof PreferenceActionImpl>;

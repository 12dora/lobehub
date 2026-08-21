import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { type DisplayContextMemory } from '@/database/repositories/userMemory';
import { userMemoryKeys } from '@/libs/swr/keys';
import { memoryCRUDService, userMemoryService } from '@/services/userMemory';
import { type StoreSetter } from '@/store/types';
import { LayersEnum } from '@/types/userMemory';
import { setNamespace } from '@/utils/storeDebug';

import { type UserMemoryStore } from '../../store';
import { revalidateMemoryList } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/context');

export interface ContextQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'capturedAt' | 'scoreImpact' | 'scoreUrgency';
}

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
    const { contextsPage, contextsTotal, contexts } = this.#get();
    if (contexts.length < (contextsTotal || 0)) {
      this.#set(
        produce((draft) => {
          draft.contextsPage = contextsPage + 1;
        }),
        false,
        n('loadMoreContexts'),
      );
    }
  };

  /**
   * Force a re-read of the list after a write.
   *
   * A mutation doesn't change the query, so it can't go through
   * `resetContextsList` (which now no-ops on an unchanged query) and it can't
   * rely on the SWR key changing either. Rewind to page 1 so the accumulated
   * pages can't resurrect a row that was just removed, then revalidate.
   */
  #refreshContextsList = async (): Promise<void> => {
    this.#set(
      produce((draft) => {
        draft.contextsPage = 1;
        draft.contextsSearchLoading = true;
      }),
      false,
      n('refreshContextsList'),
    );

    await revalidateMemoryList(userMemoryKeys.contexts.root);
  };

  resetContextsList = (params?: Omit<ContextQueryParams, 'page' | 'pageSize'>): void => {
    const state = this.#get();

    // Nothing to reset when the query is the one the store already fetched.
    // The pages call this from a mount effect, so without this guard every
    // visit wiped the rows it had and replaced the list with a skeleton.
    const isSameQuery = state.contextsQuery === params?.q && state.contextsSort === params?.sort;

    if (isSameQuery && state.contextsInit) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `contexts`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton), and the page-1 response below
        // replaces them wholesale.
        draft.contextsPage = 1;
        draft.contextsQuery = params?.q;
        draft.contextsSearchLoading = true;
        draft.contextsSort = params?.sort;
      }),
      false,
      n('resetContextsList'),
    );
  };

  useFetchContexts = (params: ContextQueryParams): SWRResponse<any> => {
    const page = params.page ?? 1;

    return useSWR(
      userMemoryKeys.contexts(params),
      async () => {
        const result = await userMemoryService.queryMemories({
          layer: LayersEnum.Context,
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
              draft.contextsSearchLoading = false;
            }),
            false,
            n('useFetchContexts/onError'),
          );
        },
        onSuccess: (data: any) => {
          this.#set(
            produce((draft) => {
              draft.contextsSearchLoading = false;
              draft.contextsInit = true;
              draft.contextsTotal = data.total;

              // Transform data structure
              const transformedItems: DisplayContextMemory[] = data.items.map((item: any) => ({
                ...item.memory,
                ...item.context,
                source: null,
              }));

              // Accumulate data logic
              if (page === 1) {
                // First page, set directly
                draft.contexts = uniqBy(transformedItems, 'id');
              } else {
                // Subsequent pages, accumulate data
                draft.contexts = uniqBy([...draft.contexts, ...transformedItems], 'id');
              }

              // Update hasMore
              draft.contextsHasMore = data.items.length >= (params.pageSize || 20);
            }),
            false,
            n('useFetchContexts/onSuccess'),
          );
        },
        revalidateOnFocus: false,
      },
    );
  };
}

export type ContextAction = Pick<ContextActionImpl, keyof ContextActionImpl>;

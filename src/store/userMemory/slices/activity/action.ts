import { type ActivityListResult } from '@lobechat/types';
import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { userMemoryKeys } from '@/libs/swr/keys';
import { memoryCRUDService, userMemoryService } from '@/services/userMemory';
import { type StoreSetter } from '@/store/types';
import { setNamespace } from '@/utils/storeDebug';

import { type UserMemoryStore } from '../../store';
import { revalidateMemoryList } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/activity');

export interface ActivityQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'capturedAt' | 'startsAt';
  status?: string[];
  types?: string[];
}

type Setter = StoreSetter<UserMemoryStore>;
export const createActivitySlice = (set: Setter, get: () => UserMemoryStore, _api?: unknown) =>
  new ActivityActionImpl(set, get, _api);

export class ActivityActionImpl {
  readonly #get: () => UserMemoryStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => UserMemoryStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  deleteActivity = async (id: string): Promise<void> => {
    await memoryCRUDService.deleteActivity(id);
    await this.#refreshActivitiesList();
  };

  loadMoreActivities = (): void => {
    const { activitiesPage, activitiesTotal, activities } = this.#get();
    if (activities.length < (activitiesTotal || 0)) {
      this.#set(
        produce((draft) => {
          draft.activitiesPage = activitiesPage + 1;
        }),
        false,
        n('loadMoreActivities'),
      );
    }
  };

  /**
   * Force a re-read of the list after a write.
   *
   * A mutation doesn't change the query, so it can't go through
   * `resetActivitiesList` (which now no-ops on an unchanged query) and it can't
   * rely on the SWR key changing either. Rewind to page 1 so the accumulated
   * pages can't resurrect a row that was just removed, then revalidate.
   */
  #refreshActivitiesList = async (): Promise<void> => {
    this.#set(
      produce((draft) => {
        draft.activitiesPage = 1;
        draft.activitiesSearchLoading = true;
      }),
      false,
      n('refreshActivitiesList'),
    );

    await revalidateMemoryList(userMemoryKeys.activities.root);
  };

  resetActivitiesList = (params?: Omit<ActivityQueryParams, 'page' | 'pageSize'>): void => {
    const state = this.#get();

    // Nothing to reset when the query is the one the store already fetched.
    // The pages call this from a mount effect, so without this guard every
    // visit wiped the rows it had and replaced the list with a skeleton.
    const isSameQuery =
      state.activitiesQuery === params?.q && state.activitiesSort === params?.sort;

    if (isSameQuery && state.activitiesInit) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `activities`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton), and the page-1 response below
        // replaces them wholesale.
        draft.activitiesPage = 1;
        draft.activitiesQuery = params?.q;
        draft.activitiesSearchLoading = true;
        draft.activitiesSort = params?.sort;
      }),
      false,
      n('resetActivitiesList'),
    );
  };

  useFetchActivities = (params: ActivityQueryParams): SWRResponse<ActivityListResult> => {
    const page = params.page ?? 1;

    return useSWR(
      userMemoryKeys.activities(params),
      async () => {
        return userMemoryService.queryActivities({
          page: params.page,
          pageSize: params.pageSize,
          q: params.q,
          sort: params.sort,
          status: params.status,
          types: params.types,
        });
      },
      {
        onError: () => {
          // Otherwise the refreshing affordance would spin forever on a failed
          // revalidation.
          this.#set(
            produce((draft) => {
              draft.activitiesSearchLoading = false;
            }),
            false,
            n('useFetchActivities/onError'),
          );
        },
        onSuccess: (data: ActivityListResult) => {
          this.#set(
            produce((draft) => {
              draft.activitiesSearchLoading = false;
              draft.activitiesTotal = data.total;

              if (!draft.activitiesInit) {
                draft.activitiesInit = true;
              }

              if (page === 1) {
                draft.activities = uniqBy(data.items, 'id');
              } else {
                draft.activities = uniqBy([...draft.activities, ...data.items], 'id');
              }

              draft.activitiesHasMore = data.items.length >= (params.pageSize || 20);
            }),
            false,
            n('useFetchActivities/onSuccess'),
          );
        },
        revalidateOnFocus: false,
      },
    );
  };
}

export type ActivityAction = Pick<ActivityActionImpl, keyof ActivityActionImpl>;

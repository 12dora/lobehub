import { type ActivityListResult } from '@lobechat/types';
import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { useEffect } from 'react';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { userMemoryKeys } from '@/libs/swr/keys';
import { memoryCRUDService, userMemoryService } from '@/services/userMemory';
import { type StoreSetter } from '@/store/types';
import { setNamespace } from '@/utils/storeDebug';

import { type UserMemoryStore } from '../../store';
import { DEFAULT_MEMORY_LIST_PAGE_SIZE, memoryListQueryKey } from '../../utils/listQuery';
import { dropMemoryListCache } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/activity');

export interface ActivityQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'capturedAt' | 'startsAt';
  status?: string[];
  types?: string[];
}

type ActivityFilter = Omit<ActivityQueryParams, 'page' | 'pageSize'>;

/**
 * Every filter field of `ActivityQueryParams` — pagination excluded. `status`
 * and `types` narrow the result set exactly like `q` does, so leaving them out
 * would let a status-filtered response be written into an unfiltered list.
 */
const activityQueryKey = (params?: ActivityFilter): string =>
  memoryListQueryKey({
    q: params?.q,
    sort: params?.sort,
    status: params?.status,
    types: params?.types,
  });

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
    const {
      activities,
      activitiesHasMore,
      activitiesPage,
      activitiesSearchLoading,
      activitiesTotal,
    } = this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for page 2 of the new
    // query and append it to those rows, leaving the list permanently mixed and
    // page 1 of the new query missing. `hasMore` is also latched false across a
    // reset, which stops the virtualized `endReached` from firing at all.
    if (activitiesSearchLoading || !activitiesHasMore) return;
    if (activities.length >= (activitiesTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.activitiesPage = activitiesPage + 1;
      }),
      false,
      n('loadMoreActivities'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetActivitiesList` (a
   * no-op on an unchanged query) nor a key change can drive it. Rewind to page
   * 1, drop every cached page of the list, then fetch page 1 here rather than
   * hoping a subscriber revalidates — the store's page and React's subscription
   * move at different times, so "revalidate whatever is subscribed" would have
   * refreshed the page the user happened to be on, not the one the store is
   * about to render.
   */
  #refreshActivitiesList = async (): Promise<void> => {
    const state = this.#get();
    const params: ActivityQueryParams = {
      page: 1,
      pageSize: state.activitiesPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.activitiesQuery,
      sort: state.activitiesSort,
      status: state.activitiesStatus,
      types: state.activitiesTypes,
    };

    this.#set(
      produce((draft) => {
        draft.activitiesError = undefined;
        draft.activitiesHasMore = false;
        draft.activitiesPage = 1;
        draft.activitiesSearchLoading = true;
        draft.activitiesSettled = false;
      }),
      false,
      n('refreshActivitiesList'),
    );

    await dropMemoryListCache(userMemoryKeys.activities.root);

    try {
      const data = await userMemoryService.queryActivities(params);
      this.#applyActivitiesPage(params, data);
    } catch (error) {
      this.#failActivitiesPage(params, error);
    }
  };

  resetActivitiesList = (params?: ActivityFilter): void => {
    const state = this.#get();
    const nextQueryKey = activityQueryKey(params);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped
    // the rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.activitiesQueryKey && state.activitiesSettled) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `activities`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.activitiesError = undefined;
        draft.activitiesHasMore = false;
        draft.activitiesPage = 1;
        draft.activitiesQuery = params?.q;
        draft.activitiesQueryKey = nextQueryKey;
        draft.activitiesSearchLoading = true;
        draft.activitiesSettled = false;
        draft.activitiesSort = params?.sort;
        draft.activitiesStatus = params?.status;
        draft.activitiesTypes = params?.types;
      }),
      false,
      n('resetActivitiesList'),
    );
  };

  useFetchActivities = (params: ActivityQueryParams): SWRResponse<ActivityListResult> => {
    const queryKey = activityQueryKey(params);
    const page = params.page ?? 1;

    const swr = useSWR(
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
        onError: (error) => this.#failActivitiesPage(params, error),
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
      this.#applyActivitiesPage(params, data);
    }, [data, queryKey, page]);

    return swr;
  };

  /** Write one page into the list — only if it still belongs to what's on screen. */
  #applyActivitiesPage = (params: ActivityQueryParams, data: ActivityListResult): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (activityQueryKey(params) !== state.activitiesQueryKey) return;
    if (page !== state.activitiesPage) return;

    this.#set(
      produce((draft) => {
        draft.activitiesError = undefined;
        draft.activitiesHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.activitiesPageSize = params.pageSize ?? draft.activitiesPageSize;
        draft.activitiesSearchLoading = false;
        draft.activitiesSettled = true;
        draft.activitiesTotal = data.total;
        draft.activities =
          page === 1
            ? uniqBy(data.items, 'id')
            : uniqBy([...draft.activities, ...data.items], 'id');
      }),
      false,
      n('applyActivitiesPage'),
    );
  };

  /** Record a failure for the query on screen so the page can offer a retry. */
  #failActivitiesPage = (params: ActivityQueryParams, error: unknown): void => {
    if (activityQueryKey(params) !== this.#get().activitiesQueryKey) return;

    this.#set(
      produce((draft) => {
        draft.activitiesError = error;
        draft.activitiesSearchLoading = false;
      }),
      false,
      n('failActivitiesPage'),
    );
  };
}

export type ActivityAction = Pick<ActivityActionImpl, keyof ActivityActionImpl>;

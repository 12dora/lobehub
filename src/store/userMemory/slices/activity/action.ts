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
import {
  DEFAULT_MEMORY_LIST_PAGE_SIZE,
  memoryListQueryKey,
  nextMemoryListEpoch,
} from '../../utils/listQuery';
import { dropMemoryListCache, pruneMemoryListCache } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/activity');

export interface ActivityQueryParams {
  /** Request epoch — part of the SWR key, never sent to the service. */
  epoch?: number;
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
    await this.refreshActivitiesList();
  };

  loadMoreActivities = (): void => {
    const {
      activities,
      activitiesHasMore,
      activitiesPage,
      activitiesPageError,
      activitiesPendingPage,
      activitiesSearchLoading,
      activitiesTotal,
    } = this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for the next page of the
    // new query and append it to those rows, leaving the list permanently mixed
    // and the new query's page 1 missing.
    if (activitiesSearchLoading || !activitiesHasMore) return;

    // One page request at a time. Remounting the virtualizer (a grid <-> timeline
    // switch, say) lands the viewport at the end again and fires `endReached` a
    // second time; without this latch that skipped straight to page 3, and page 2
    // — rejected by the page guard when it finally landed — was lost for good.
    if (activitiesPendingPage !== undefined) return;

    // A failed page is retried explicitly (see `retryActivitiesPage`), never by
    // silently asking for the page after it.
    if (activitiesPageError) return;

    if (activities.length >= (activitiesTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.activitiesPage = activitiesPage + 1;
        draft.activitiesPendingPage = activitiesPage + 1;
      }),
      false,
      n('loadMoreActivities'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetActivitiesList` (a no-op on
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
  refreshActivitiesList = async (): Promise<void> => {
    const state = this.#get();
    const request = {
      page: 1,
      pageSize: state.activitiesPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.activitiesQuery,
      sort: state.activitiesSort,
      status: state.activitiesStatus,
      types: state.activitiesTypes,
    };
    // `epoch` never reaches the service — it exists so the guards can tell this
    // response apart from one belonging to a different mount of the query.
    const params: ActivityQueryParams = { ...request, epoch: state.activitiesEpoch };

    // Every in-flight request for this list is now stale, and they cannot be
    // told apart by key and page alone — two overlapping refreshes of the same
    // query both look like "page 1 of this query". The generation is what
    // separates them, so the older one is dropped even if it lands last. The
    // query identity does not change here, which is exactly why the counter
    // has to move.
    const generation = state.activitiesGeneration + 1;

    this.#set(
      produce((draft) => {
        draft.activitiesError = undefined;
        draft.activitiesGeneration = generation;
        draft.activitiesHasMore = false;
        draft.activitiesPage = 1;
        draft.activitiesPageError = undefined;
        draft.activitiesPendingPage = undefined;
        draft.activitiesSearchLoading = true;
        draft.activitiesSettled = false;
      }),
      false,
      n('refreshActivitiesList'),
    );

    await dropMemoryListCache(userMemoryKeys.activities.root);

    try {
      const data = await userMemoryService.queryActivities(request);
      this.#applyActivitiesPage(params, data, generation);
    } catch (error) {
      this.#failActivitiesPage(params, error, generation);
    }
  };

  resetActivitiesList = (params?: ActivityFilter, epoch?: number): void => {
    const state = this.#get();
    const nextQueryKey = activityQueryKey(params);
    // Callers outside the page (tests, tooling) don't own an epoch; mint one so
    // the counter stays monotonic either way.
    const nextEpoch = epoch ?? nextMemoryListEpoch();

    // Keys from earlier mounts of this list can never be read again. Pruned
    // before the early return below, or a list that is only ever revisited
    // (never re-filtered) would never prune at all.
    pruneMemoryListCache(userMemoryKeys.activities.root);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped the
    // rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.activitiesQueryKey && state.activitiesSettled) {
      if (nextEpoch === state.activitiesEpoch) return;

      this.#set(
        produce((draft) => {
          // The rows stay on screen, but this mount's epoch has to be adopted:
          // it is already in the SWR key of the revalidation the remount just
          // started, and a response the store won't recognise is one it drops.
          draft.activitiesEpoch = nextEpoch;

          // And that revalidation has to start from page 1. Leaving the page
          // number where the last visit ended re-read *only* that page and
          // appended it to pages the server has since changed: rows deleted in
          // the meantime survived in the pages nothing re-read, and the list
          // could end up longer than its own total. Page 1 replaces the
          // accumulated rows wholesale (see `#applyActivitiesPage`) and recomputes
          // `hasMore` from what actually came back.
          draft.activitiesPage = 1;
          draft.activitiesPageError = undefined;
          draft.activitiesPendingPage = undefined;

          // Pagination has to be latched off for the same reason the reset path
          // latches it: the rows are still on screen, so `endReached` can fire
          // at the bottom of them while page 1 is in flight. That advanced to
          // page 2, page 1 was then rejected by the page guard, and page 2 was
          // appended to rows the server had already moved on from.
          draft.activitiesHasMore = false;
        }),
        false,
        n('adoptActivitiesEpoch'),
      );

      return;
    }

    this.#set(
      produce((draft) => {
        // Deliberately keep `activities`: the rows already on screen stay put while
        // the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.activitiesEpoch = nextEpoch;
        draft.activitiesError = undefined;
        // The epoch tells one *mount* of a query from another; the generation
        // tells one invalidation round from another *within* a mount, which is
        // the case the epoch cannot see because a post-write refresh leaves the
        // key (and therefore the epoch) untouched. Both only ever go up.
        //
        // Step it only for a retry — same query, same epoch — where nothing
        // else separates the new attempt from the one that failed. A different
        // epoch must NOT step it: SWR starts that mount's request from a layout
        // effect, before this runs, so the request captured the generation as
        // it is now and bumping here would reject the very response the remount
        // is waiting for, leaving the list loading forever.
        draft.activitiesGeneration =
          nextQueryKey === state.activitiesQueryKey && nextEpoch === state.activitiesEpoch
            ? state.activitiesGeneration + 1
            : state.activitiesGeneration;
        draft.activitiesHasMore = false;
        draft.activitiesPage = 1;
        draft.activitiesPageError = undefined;
        draft.activitiesPendingPage = undefined;
        draft.activitiesQueryKey = nextQueryKey;
        draft.activitiesQuery = params?.q;
        draft.activitiesSort = params?.sort;
        draft.activitiesStatus = params?.status;
        draft.activitiesTypes = params?.types;
        draft.activitiesSearchLoading = true;
        draft.activitiesSettled = false;
      }),
      false,
      n('resetActivitiesList'),
    );
  };

  /**
   * Retry the page that failed, not the one after it.
   *
   * The page renders a retryable footer for a pagination failure; the component
   * revalidates the SWR key it is already on, which is exactly the failed page
   * because `activitiesPage` was never advanced past it.
   */
  retryActivitiesPage = (): void => {
    const { activitiesPage, activitiesPageError } = this.#get();
    if (!activitiesPageError) return;

    this.#set(
      produce((draft) => {
        draft.activitiesPageError = undefined;
        draft.activitiesPendingPage = activitiesPage;
      }),
      false,
      n('retryActivitiesPage'),
    );
  };

  useFetchActivities = (params: ActivityQueryParams): SWRResponse<ActivityListResult> => {
    const swr = useSWR<ActivityListResult>(
      userMemoryKeys.activities(params),
      async () => {
        // Captured before the request, never read back after it: that is what
        // lets a response which was already in flight when a write evicted the
        // list be told apart from a fresh one.
        const generation = this.#get().activitiesGeneration;

        try {
          const data = await userMemoryService.queryActivities({
            page: params.page,
            pageSize: params.pageSize,
            q: params.q,
            sort: params.sort,
            status: params.status,
            types: params.types,
          });
          this.#applyActivitiesPage(params, data, generation);
          return data;
        } catch (error) {
          this.#failActivitiesPage(params, error, generation);
          throw error;
        }
      },
      { revalidateOnFocus: false },
    );

    // No cache-bootstrap path: the key carries `params.epoch`, which changes
    // with every mount of a query, so there is never a cached entry to fall
    // back on and the fetcher always runs. That is deliberate — the bootstrap
    // it replaces had no way to know which request produced the cached rows,
    // and would happily settle a returned-to list with an earlier visit's data.
    return swr;
  };

  /**
   * Write one page into the list.
   *
   * Four things have to line up: the query identity, the epoch of the mount
   * that asked, the page the store is waiting for, and the generation the
   * request captured when it started.
   */
  #applyActivitiesPage = (
    params: ActivityQueryParams,
    data: ActivityListResult,
    generation: number,
  ): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (activityQueryKey(params) !== state.activitiesQueryKey) return;
    if (params.epoch !== state.activitiesEpoch) return;
    if (page !== state.activitiesPage) return;
    if (generation !== state.activitiesGeneration) return;

    const items = data.items;

    this.#set(
      produce((draft) => {
        draft.activitiesError = undefined;
        draft.activitiesHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.activitiesPageError = undefined;
        draft.activitiesPageSize = params.pageSize ?? draft.activitiesPageSize;
        draft.activitiesPendingPage = undefined;
        draft.activitiesSearchLoading = false;
        draft.activitiesSettled = true;
        draft.activitiesTotal = data.total;
        draft.activities =
          page === 1 ? uniqBy(items, 'id') : uniqBy([...draft.activities, ...items], 'id');
      }),
      false,
      n('applyActivitiesPage'),
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
  #failActivitiesPage = (params: ActivityQueryParams, error: unknown, generation: number): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (activityQueryKey(params) !== state.activitiesQueryKey) return;
    if (params.epoch !== state.activitiesEpoch) return;
    if (page !== state.activitiesPage) return;
    if (generation !== state.activitiesGeneration) return;

    this.#set(
      produce((draft) => {
        draft.activitiesPendingPage = undefined;

        // Rows on screen — a later page, or a revalidation of page 1 started by
        // a remount — keep them and offer a retry. Only a query with nothing to
        // show yet becomes a whole-list failure. Without the `settled` half of
        // this, a failed remount revalidation left the list readable but frozen:
        // no error, and `hasMore` latched off with nothing left to unlatch it.
        if (page > 1 || state.activitiesSettled) {
          draft.activitiesPageError = error;
          return;
        }

        draft.activitiesError = error;
        draft.activitiesSearchLoading = false;
      }),
      false,
      n('failActivitiesPage'),
    );
  };
}

export type ActivityAction = Pick<ActivityActionImpl, keyof ActivityActionImpl>;

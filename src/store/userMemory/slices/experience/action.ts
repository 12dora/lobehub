import { type ExperienceListResult } from '@lobechat/types';
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

const n = setNamespace('userMemory/experience');

export interface ExperienceQueryParams {
  /** Request epoch — part of the SWR key, never sent to the service. */
  epoch?: number;
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'capturedAt' | 'scoreConfidence';
}

type ExperienceFilter = Omit<ExperienceQueryParams, 'page' | 'pageSize'>;

/**
 * Every filter field of `ExperienceQueryParams` — pagination excluded.
 */
const experienceQueryKey = (params?: ExperienceFilter): string =>
  memoryListQueryKey({ q: params?.q, sort: params?.sort });

type Setter = StoreSetter<UserMemoryStore>;
export const createExperienceSlice = (set: Setter, get: () => UserMemoryStore, _api?: unknown) =>
  new ExperienceActionImpl(set, get, _api);

export class ExperienceActionImpl {
  readonly #get: () => UserMemoryStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => UserMemoryStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  deleteExperience = async (id: string): Promise<void> => {
    await memoryCRUDService.deleteExperience(id);
    await this.refreshExperiencesList();
  };

  loadMoreExperiences = (): void => {
    const {
      experiences,
      experiencesHasMore,
      experiencesPage,
      experiencesPageError,
      experiencesPendingPage,
      experiencesSearchLoading,
      experiencesTotal,
    } = this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for the next page of the
    // new query and append it to those rows, leaving the list permanently mixed
    // and the new query's page 1 missing.
    if (experiencesSearchLoading || !experiencesHasMore) return;

    // One page request at a time. Remounting the virtualizer (a grid <-> timeline
    // switch, say) lands the viewport at the end again and fires `endReached` a
    // second time; without this latch that skipped straight to page 3, and page 2
    // — rejected by the page guard when it finally landed — was lost for good.
    if (experiencesPendingPage !== undefined) return;

    // A failed page is retried explicitly (see `retryExperiencesPage`), never by
    // silently asking for the page after it.
    if (experiencesPageError) return;

    if (experiences.length >= (experiencesTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.experiencesPage = experiencesPage + 1;
        draft.experiencesPendingPage = experiencesPage + 1;
      }),
      false,
      n('loadMoreExperiences'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetExperiencesList` (a no-op on
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
  refreshExperiencesList = async (): Promise<void> => {
    const state = this.#get();
    const request = {
      page: 1,
      pageSize: state.experiencesPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.experiencesQuery,
      sort: state.experiencesSort,
    };
    // `epoch` never reaches the service — it exists so the guards can tell this
    // response apart from one belonging to a different mount of the query.
    const params: ExperienceQueryParams = { ...request, epoch: state.experiencesEpoch };

    // Every in-flight request for this list is now stale, and they cannot be
    // told apart by key and page alone — two overlapping refreshes of the same
    // query both look like "page 1 of this query". The generation is what
    // separates them, so the older one is dropped even if it lands last. The
    // query identity does not change here, which is exactly why the counter
    // has to move.
    const generation = state.experiencesGeneration + 1;

    this.#set(
      produce((draft) => {
        draft.experiencesError = undefined;
        draft.experiencesGeneration = generation;
        draft.experiencesHasMore = false;
        draft.experiencesPage = 1;
        draft.experiencesPageError = undefined;
        draft.experiencesPendingPage = undefined;
        draft.experiencesSearchLoading = true;
        draft.experiencesSettled = false;
      }),
      false,
      n('refreshExperiencesList'),
    );

    await dropMemoryListCache(userMemoryKeys.experiences.root);

    try {
      const data = await userMemoryService.queryExperiences(request);
      this.#applyExperiencesPage(params, data, generation);
    } catch (error) {
      this.#failExperiencesPage(params, error, generation);
    }
  };

  resetExperiencesList = (params?: ExperienceFilter, epoch?: number): void => {
    const state = this.#get();
    const nextQueryKey = experienceQueryKey(params);
    // Callers outside the page (tests, tooling) don't own an epoch; mint one so
    // the counter stays monotonic either way.
    const nextEpoch = epoch ?? nextMemoryListEpoch();

    // Keys from earlier mounts of this list can never be read again. Pruned
    // before the early return below, or a list that is only ever revisited
    // (never re-filtered) would never prune at all.
    pruneMemoryListCache(userMemoryKeys.experiences.root);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped the
    // rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.experiencesQueryKey && state.experiencesSettled) {
      if (nextEpoch === state.experiencesEpoch) return;

      this.#set(
        produce((draft) => {
          // The rows stay on screen, but this mount's epoch has to be adopted:
          // it is already in the SWR key of the revalidation the remount just
          // started, and a response the store won't recognise is one it drops.
          draft.experiencesEpoch = nextEpoch;

          // And that revalidation has to start from page 1. Leaving the page
          // number where the last visit ended re-read *only* that page and
          // appended it to pages the server has since changed: rows deleted in
          // the meantime survived in the pages nothing re-read, and the list
          // could end up longer than its own total. Page 1 replaces the
          // accumulated rows wholesale (see `#applyExperiencesPage`) and recomputes
          // `hasMore` from what actually came back.
          draft.experiencesPage = 1;
          draft.experiencesPageError = undefined;
          draft.experiencesPendingPage = undefined;

          // Pagination has to be latched off for the same reason the reset path
          // latches it: the rows are still on screen, so `endReached` can fire
          // at the bottom of them while page 1 is in flight. That advanced to
          // page 2, page 1 was then rejected by the page guard, and page 2 was
          // appended to rows the server had already moved on from.
          draft.experiencesHasMore = false;
        }),
        false,
        n('adoptExperiencesEpoch'),
      );

      return;
    }

    this.#set(
      produce((draft) => {
        // Deliberately keep `experiences`: the rows already on screen stay put while
        // the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.experiencesEpoch = nextEpoch;
        draft.experiencesError = undefined;
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
        draft.experiencesGeneration =
          nextQueryKey === state.experiencesQueryKey && nextEpoch === state.experiencesEpoch
            ? state.experiencesGeneration + 1
            : state.experiencesGeneration;
        draft.experiencesHasMore = false;
        draft.experiencesPage = 1;
        draft.experiencesPageError = undefined;
        draft.experiencesPendingPage = undefined;
        draft.experiencesQueryKey = nextQueryKey;
        draft.experiencesQuery = params?.q;
        draft.experiencesSort = params?.sort;
        draft.experiencesSearchLoading = true;
        draft.experiencesSettled = false;
      }),
      false,
      n('resetExperiencesList'),
    );
  };

  /**
   * Retry the page that failed, not the one after it.
   *
   * The page renders a retryable footer for a pagination failure; the component
   * revalidates the SWR key it is already on, which is exactly the failed page
   * because `experiencesPage` was never advanced past it.
   */
  retryExperiencesPage = (): void => {
    const { experiencesPage, experiencesPageError } = this.#get();
    if (!experiencesPageError) return;

    this.#set(
      produce((draft) => {
        draft.experiencesPageError = undefined;
        draft.experiencesPendingPage = experiencesPage;
      }),
      false,
      n('retryExperiencesPage'),
    );
  };

  useFetchExperiences = (params: ExperienceQueryParams): SWRResponse<ExperienceListResult> => {
    const swr = useSWR<ExperienceListResult>(
      userMemoryKeys.experiences(params),
      async () => {
        // Captured before the request, never read back after it: that is what
        // lets a response which was already in flight when a write evicted the
        // list be told apart from a fresh one.
        const generation = this.#get().experiencesGeneration;

        try {
          const data = await userMemoryService.queryExperiences({
            page: params.page,
            pageSize: params.pageSize,
            q: params.q,
            sort: params.sort,
          });
          this.#applyExperiencesPage(params, data, generation);
          return data;
        } catch (error) {
          this.#failExperiencesPage(params, error, generation);
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
  #applyExperiencesPage = (
    params: ExperienceQueryParams,
    data: ExperienceListResult,
    generation: number,
  ): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (experienceQueryKey(params) !== state.experiencesQueryKey) return;
    if (params.epoch !== state.experiencesEpoch) return;
    if (page !== state.experiencesPage) return;
    if (generation !== state.experiencesGeneration) return;

    // Backend returns a flat structure directly, no transformation needed.
    const items = data.items;

    this.#set(
      produce((draft) => {
        draft.experiencesError = undefined;
        draft.experiencesHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.experiencesPageError = undefined;
        draft.experiencesPageSize = params.pageSize ?? draft.experiencesPageSize;
        draft.experiencesPendingPage = undefined;
        draft.experiencesSearchLoading = false;
        draft.experiencesSettled = true;
        draft.experiencesTotal = data.total;
        draft.experiences =
          page === 1 ? uniqBy(items, 'id') : uniqBy([...draft.experiences, ...items], 'id');
      }),
      false,
      n('applyExperiencesPage'),
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
  #failExperiencesPage = (
    params: ExperienceQueryParams,
    error: unknown,
    generation: number,
  ): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (experienceQueryKey(params) !== state.experiencesQueryKey) return;
    if (params.epoch !== state.experiencesEpoch) return;
    if (page !== state.experiencesPage) return;
    if (generation !== state.experiencesGeneration) return;

    this.#set(
      produce((draft) => {
        draft.experiencesPendingPage = undefined;

        // Rows on screen — a later page, or a revalidation of page 1 started by
        // a remount — keep them and offer a retry. Only a query with nothing to
        // show yet becomes a whole-list failure. Without the `settled` half of
        // this, a failed remount revalidation left the list readable but frozen:
        // no error, and `hasMore` latched off with nothing left to unlatch it.
        if (page > 1 || state.experiencesSettled) {
          draft.experiencesPageError = error;
          return;
        }

        draft.experiencesError = error;
        draft.experiencesSearchLoading = false;
      }),
      false,
      n('failExperiencesPage'),
    );
  };
}

export type ExperienceAction = Pick<ExperienceActionImpl, keyof ExperienceActionImpl>;

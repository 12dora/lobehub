import {
  type IdentityListResult,
  type NewUserMemoryIdentity,
  type UpdateUserMemoryIdentity,
} from '@lobechat/types';
import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { type AddIdentityEntryResult } from '@/database/models/userMemory';
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

const n = setNamespace('userMemory/identity');

export interface IdentityQueryParams {
  /** Request epoch — part of the SWR key, never sent to the service. */
  epoch?: number;
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
    const request = {
      page: 1,
      pageSize: state.identitiesPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.identitiesQuery,
      relationships: state.identitiesRelationships,
      sort: state.identitiesSort,
      types: state.identitiesTypes,
    };
    // `epoch` never reaches the service — it exists so the guards can tell this
    // response apart from one belonging to a different mount of the query.
    const params: IdentityQueryParams = { ...request, epoch: state.identitiesEpoch };

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
      const data = await userMemoryService.queryIdentities(request);
      this.#applyIdentitiesPage(params, data, generation);
    } catch (error) {
      this.#failIdentitiesPage(params, error, generation);
    }
  };

  resetIdentitiesList = (params?: IdentityFilter, epoch?: number): void => {
    const state = this.#get();
    const nextQueryKey = identityQueryKey(params);
    // Callers outside the page (tests, tooling) don't own an epoch; mint one so
    // the counter stays monotonic either way.
    const nextEpoch = epoch ?? nextMemoryListEpoch();

    // Keys from earlier mounts of this list can never be read again. Pruned
    // before the early return below, or a list that is only ever revisited
    // (never re-filtered) would never prune at all.
    pruneMemoryListCache(userMemoryKeys.identityList.root);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped the
    // rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.identitiesQueryKey && state.identitiesSettled) {
      if (nextEpoch === state.identitiesEpoch) return;

      this.#set(
        produce((draft) => {
          // The rows stay on screen, but this mount's epoch has to be adopted:
          // it is already in the SWR key of the revalidation the remount just
          // started, and a response the store won't recognise is one it drops.
          draft.identitiesEpoch = nextEpoch;

          // And that revalidation has to start from page 1. Leaving the page
          // number where the last visit ended re-read *only* that page and
          // appended it to pages the server has since changed: rows deleted in
          // the meantime survived in the pages nothing re-read, and the list
          // could end up longer than its own total. Page 1 replaces the
          // accumulated rows wholesale (see `#applyIdentitiesPage`) and recomputes
          // `hasMore` from what actually came back.
          draft.identitiesPage = 1;
          draft.identitiesPageError = undefined;
          draft.identitiesPendingPage = undefined;
        }),
        false,
        n('adoptIdentitiesEpoch'),
      );

      return;
    }

    this.#set(
      produce((draft) => {
        // Deliberately keep `identities`: the rows already on screen stay put while
        // the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.identitiesEpoch = nextEpoch;
        draft.identitiesError = undefined;
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
        draft.identitiesGeneration =
          nextQueryKey === state.identitiesQueryKey && nextEpoch === state.identitiesEpoch
            ? state.identitiesGeneration + 1
            : state.identitiesGeneration;
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
  #applyIdentitiesPage = (
    params: IdentityQueryParams,
    data: IdentityListResult,
    generation: number,
  ): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (identityQueryKey(params) !== state.identitiesQueryKey) return;
    if (params.epoch !== state.identitiesEpoch) return;
    if (page !== state.identitiesPage) return;
    if (generation !== state.identitiesGeneration) return;

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
    if (params.epoch !== state.identitiesEpoch) return;
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

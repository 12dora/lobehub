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

/** Every filter field of `IdentityQueryParams` — pagination excluded. */
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
    await this.#refreshIdentitiesList();
    return result;
  };

  deleteIdentity = async (id: string): Promise<void> => {
    await memoryCRUDService.deleteIdentity(id);
    await this.#refreshIdentitiesList();
  };

  loadMoreIdentities = (): void => {
    const {
      identities,
      identitiesHasMore,
      identitiesPage,
      identitiesSearchLoading,
      identitiesTotal,
    } = this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for page 2 of the new
    // query and append it to those rows, leaving the list permanently mixed and
    // page 1 of the new query missing. `hasMore` is also latched false across a
    // reset, which stops the virtualized `endReached` from firing at all.
    if (identitiesSearchLoading || !identitiesHasMore) return;
    if (identities.length >= (identitiesTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.identitiesPage = identitiesPage + 1;
      }),
      false,
      n('loadMoreIdentities'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetIdentitiesList` (a
   * no-op on an unchanged query) nor a key change can drive it. Rewind to page
   * 1, drop every cached page of the list, then fetch page 1 here rather than
   * hoping a subscriber revalidates — the store's page and React's subscription
   * move at different times, so "revalidate whatever is subscribed" would have
   * refreshed the page the user happened to be on, not the one the store is
   * about to render.
   */
  #refreshIdentitiesList = async (): Promise<void> => {
    const state = this.#get();
    const params: IdentityQueryParams = {
      page: 1,
      pageSize: state.identitiesPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.identitiesQuery,
      relationships: state.identitiesRelationships,
      sort: state.identitiesSort,
      types: state.identitiesTypes,
    };

    this.#set(
      produce((draft) => {
        draft.identitiesError = undefined;
        draft.identitiesHasMore = false;
        draft.identitiesPage = 1;
        draft.identitiesSearchLoading = true;
        draft.identitiesSettled = false;
      }),
      false,
      n('refreshIdentitiesList'),
    );

    await dropMemoryListCache(userMemoryKeys.identityList.root);

    try {
      const data = await userMemoryService.queryIdentities(params);
      this.#applyIdentitiesPage(params, data);
    } catch (error) {
      this.#failIdentitiesPage(params, error);
    }
  };

  resetIdentitiesList = (params?: IdentityFilter): void => {
    const state = this.#get();
    const nextQueryKey = identityQueryKey(params);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped
    // the rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.identitiesQueryKey && state.identitiesSettled) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `identities`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.identitiesError = undefined;
        draft.identitiesHasMore = false;
        draft.identitiesPage = 1;
        draft.identitiesQuery = params?.q;
        draft.identitiesQueryKey = nextQueryKey;
        draft.identitiesRelationships = params?.relationships;
        draft.identitiesSearchLoading = true;
        draft.identitiesSettled = false;
        draft.identitiesSort = params?.sort;
        draft.identitiesTypes = params?.types;
      }),
      false,
      n('resetIdentitiesList'),
    );
  };

  updateIdentity = async (id: string, data: UpdateUserMemoryIdentity): Promise<boolean> => {
    const result = await memoryCRUDService.updateIdentity(id, data);
    await this.#refreshIdentitiesList();
    return result;
  };

  useFetchIdentities = (params: IdentityQueryParams): SWRResponse<IdentityListResult> => {
    const queryKey = identityQueryKey(params);
    const page = params.page ?? 1;

    const swr = useSWR(
      userMemoryKeys.identityList(params),
      async () => {
        // Use the new dedicated queryIdentities API
        return userMemoryService.queryIdentities({
          page: params.page,
          pageSize: params.pageSize,
          q: params.q,
          relationships: params.relationships,
          sort: params.sort,
          types: params.types,
        });
      },
      {
        onError: (error) => this.#failIdentitiesPage(params, error),
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
      this.#applyIdentitiesPage(params, data);
    }, [data, queryKey, page]);

    return swr;
  };

  /** Write one page into the list — only if it still belongs to what's on screen. */
  #applyIdentitiesPage = (params: IdentityQueryParams, data: IdentityListResult): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (identityQueryKey(params) !== state.identitiesQueryKey) return;
    if (page !== state.identitiesPage) return;

    this.#set(
      produce((draft) => {
        draft.identitiesError = undefined;
        draft.identitiesHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.identitiesPageSize = params.pageSize ?? draft.identitiesPageSize;
        draft.identitiesSearchLoading = false;
        draft.identitiesSettled = true;
        draft.identitiesTotal = data.total;

        // Backend now returns flat structure directly, no transformation needed
        draft.identities =
          page === 1
            ? uniqBy(data.items, 'id')
            : uniqBy([...draft.identities, ...data.items], 'id');
      }),
      false,
      n('applyIdentitiesPage'),
    );
  };

  /** Record a failure for the query on screen so the page can offer a retry. */
  #failIdentitiesPage = (params: IdentityQueryParams, error: unknown): void => {
    if (identityQueryKey(params) !== this.#get().identitiesQueryKey) return;

    this.#set(
      produce((draft) => {
        draft.identitiesError = error;
        draft.identitiesSearchLoading = false;
      }),
      false,
      n('failIdentitiesPage'),
    );
  };
}

export type IdentityAction = Pick<IdentityActionImpl, keyof IdentityActionImpl>;

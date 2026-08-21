import {
  type IdentityListResult,
  type NewUserMemoryIdentity,
  type UpdateUserMemoryIdentity,
} from '@lobechat/types';
import { isEqual } from 'es-toolkit';
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
import { revalidateMemoryList } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/identity');

export interface IdentityQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  relationships?: string[];
  sort?: 'capturedAt' | 'type';
  types?: string[];
}

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
    const { identitiesPage, identitiesTotal, identities } = this.#get();
    if (identities.length < (identitiesTotal || 0)) {
      this.#set(
        produce((draft) => {
          draft.identitiesPage = identitiesPage + 1;
        }),
        false,
        n('loadMoreIdentities'),
      );
    }
  };

  /**
   * Force a re-read of the list after a write.
   *
   * A mutation doesn't change the query, so it can't go through
   * `resetIdentitiesList` (which now no-ops on an unchanged query) and it can't
   * rely on the SWR key changing either. Rewind to page 1 so the accumulated
   * pages can't resurrect a row that was just removed, then revalidate.
   */
  #refreshIdentitiesList = async (): Promise<void> => {
    this.#set(
      produce((draft) => {
        draft.identitiesPage = 1;
        draft.identitiesSearchLoading = true;
      }),
      false,
      n('refreshIdentitiesList'),
    );

    await revalidateMemoryList(userMemoryKeys.identityList.root);
  };

  resetIdentitiesList = (params?: Omit<IdentityQueryParams, 'page' | 'pageSize'>): void => {
    const state = this.#get();

    // Nothing to reset when the query is the one the store already fetched.
    // The pages call this from a mount effect, so without this guard every
    // visit wiped the rows it had and replaced the list with a skeleton.
    const isSameQuery =
      state.identitiesQuery === params?.q &&
      state.identitiesSort === params?.sort &&
      isEqual(state.identitiesRelationships, params?.relationships) &&
      isEqual(state.identitiesTypes, params?.types);

    if (isSameQuery && state.identitiesInit) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `identities`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton), and the page-1 response below
        // replaces them wholesale.
        draft.identitiesPage = 1;
        draft.identitiesQuery = params?.q;
        draft.identitiesRelationships = params?.relationships;
        draft.identitiesSearchLoading = true;
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
    const page = params.page ?? 1;

    return useSWR(
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
        onError: () => {
          // Otherwise the refreshing affordance would spin forever on a failed
          // revalidation.
          this.#set(
            produce((draft) => {
              draft.identitiesSearchLoading = false;
            }),
            false,
            n('useFetchIdentities/onError'),
          );
        },
        onSuccess: (data: IdentityListResult) => {
          this.#set(
            produce((draft) => {
              draft.identitiesSearchLoading = false;
              draft.identitiesTotal = data.total;

              if (!draft.identitiesInit) {
                draft.identitiesInit = true;
              }

              // Backend now returns flat structure directly, no transformation needed
              if (page === 1) {
                draft.identities = uniqBy(data.items, 'id');
              } else {
                draft.identities = uniqBy([...draft.identities, ...data.items], 'id');
              }

              draft.identitiesHasMore = data.items.length >= (params.pageSize || 20);
            }),
            false,
            n('useFetchIdentities/onSuccess'),
          );
        },
        revalidateOnFocus: false,
      },
    );
  };
}

export type IdentityAction = Pick<IdentityActionImpl, keyof IdentityActionImpl>;

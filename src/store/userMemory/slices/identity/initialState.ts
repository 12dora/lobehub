import { type IdentityListItem, type IdentityListSort } from '@lobechat/types';

import { type IdentityForInjection } from '../../types';

export interface IdentitySliceState {
  /** Global identities fetched at app initialization for injection into chat context */
  globalIdentities: IdentityForInjection[];
  /** When global identities were fetched */
  globalIdentitiesFetchedAt?: number;
  /** Whether global identities have been initialized */
  globalIdentitiesInit: boolean;
  identities: IdentityListItem[];
  /** Failure of the query currently on screen, if it never settled. */
  identitiesError?: unknown;
  identitiesHasMore: boolean;
  identitiesPage: number;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  identitiesPageSize?: number;
  identitiesQuery?: string;
  /** Identity of the query the rows belong to — see `memoryListQueryKey`. */
  identitiesQueryKey: string;
  identitiesRelationships?: string[];
  identitiesSearchLoading?: boolean;
  /** The query on screen has landed at least one page. */
  identitiesSettled: boolean;
  identitiesSort?: IdentityListSort;
  identitiesTotal: number;
  identitiesTypes?: string[];
}

export const identityInitialState: IdentitySliceState = {
  globalIdentities: [],
  globalIdentitiesFetchedAt: undefined,
  globalIdentitiesInit: false,
  identities: [],
  identitiesError: undefined,
  identitiesHasMore: true,
  identitiesPage: 1,
  identitiesPageSize: undefined,
  identitiesQuery: undefined,
  identitiesQueryKey: '',
  identitiesRelationships: undefined,
  identitiesSettled: false,
  identitiesSort: undefined,
  identitiesTotal: 0,
  identitiesTypes: undefined,
};

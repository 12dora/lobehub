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
  /** Request epoch of the mount whose responses this list accepts. */
  identitiesEpoch: number;
  /** Failure of the query currently on screen, if it never settled. */
  identitiesError?: unknown;
  /** Bumped whenever in-flight requests for this list become stale. */
  identitiesGeneration: number;
  identitiesHasMore: boolean;
  identitiesPage: number;
  /** Failure of a load-more page; the rows already on screen stay. */
  identitiesPageError?: unknown;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  identitiesPageSize?: number;
  /** The page a request is currently outstanding for. */
  identitiesPendingPage?: number;
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
  identitiesEpoch: 0,
  identitiesError: undefined,
  identitiesGeneration: 0,
  identitiesHasMore: true,
  identitiesPage: 1,
  identitiesPageError: undefined,
  identitiesPageSize: undefined,
  identitiesPendingPage: undefined,
  identitiesQuery: undefined,
  identitiesQueryKey: '',
  identitiesRelationships: undefined,
  identitiesSettled: false,
  identitiesSort: undefined,
  identitiesTotal: 0,
  identitiesTypes: undefined,
};

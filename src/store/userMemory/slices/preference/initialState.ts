import { type DisplayPreferenceMemory } from '@/database/repositories/userMemory';

export interface PreferenceSliceState {
  preferences: DisplayPreferenceMemory[];
  /** Request epoch of the mount whose responses this list accepts. */
  preferencesEpoch: number;
  /** Failure of the query currently on screen, if it never settled. */
  preferencesError?: unknown;
  /** Bumped whenever in-flight requests for this list become stale. */
  preferencesGeneration: number;
  preferencesHasMore: boolean;
  preferencesPage: number;
  /** Failure of a load-more page; the rows already on screen stay. */
  preferencesPageError?: unknown;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  preferencesPageSize?: number;
  /** The page a request is currently outstanding for. */
  preferencesPendingPage?: number;
  preferencesQuery?: string;
  /** Identity of the query the rows belong to — see `memoryListQueryKey`. */
  preferencesQueryKey: string;
  preferencesSearchLoading?: boolean;
  /** The query on screen has landed at least one page. */
  preferencesSettled: boolean;
  preferencesSort?: 'capturedAt' | 'scorePriority';
  preferencesTotal: number;
}

export const preferenceInitialState: PreferenceSliceState = {
  preferences: [],
  preferencesEpoch: 0,
  preferencesError: undefined,
  preferencesGeneration: 0,
  preferencesHasMore: true,
  preferencesPage: 1,
  preferencesPageError: undefined,
  preferencesPageSize: undefined,
  preferencesPendingPage: undefined,
  preferencesQuery: undefined,
  preferencesQueryKey: '',
  preferencesSettled: false,
  preferencesSort: undefined,
  preferencesTotal: 0,
};

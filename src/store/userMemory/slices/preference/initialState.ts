import { type DisplayPreferenceMemory } from '@/database/repositories/userMemory';

export interface PreferenceSliceState {
  preferences: DisplayPreferenceMemory[];
  /** Failure of the query currently on screen, if it never settled. */
  preferencesError?: unknown;
  preferencesHasMore: boolean;
  preferencesPage: number;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  preferencesPageSize?: number;
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
  preferencesError: undefined,
  preferencesHasMore: true,
  preferencesPage: 1,
  preferencesPageSize: undefined,
  preferencesQuery: undefined,
  preferencesQueryKey: '',
  preferencesSettled: false,
  preferencesSort: undefined,
  preferencesTotal: 0,
};

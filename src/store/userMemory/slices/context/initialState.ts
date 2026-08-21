import { type DisplayContextMemory } from '@/database/repositories/userMemory';

export interface ContextSliceState {
  contexts: DisplayContextMemory[];
  /** Failure of the query currently on screen, if it never settled. */
  contextsError?: unknown;
  contextsHasMore: boolean;
  contextsPage: number;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  contextsPageSize?: number;
  contextsQuery?: string;
  /** Identity of the query the rows belong to — see `memoryListQueryKey`. */
  contextsQueryKey: string;
  contextsSearchLoading?: boolean;
  /** The query on screen has landed at least one page. */
  contextsSettled: boolean;
  contextsSort?: 'capturedAt' | 'scoreImpact' | 'scoreUrgency';
  contextsTotal: number;
}

export const contextInitialState: ContextSliceState = {
  contexts: [],
  contextsError: undefined,
  contextsHasMore: true,
  contextsPage: 1,
  contextsPageSize: undefined,
  contextsQuery: undefined,
  contextsQueryKey: '',
  contextsSettled: false,
  contextsSort: undefined,
  contextsTotal: 0,
};

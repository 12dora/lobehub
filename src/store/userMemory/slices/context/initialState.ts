import { type DisplayContextMemory } from '@/database/repositories/userMemory';

export interface ContextSliceState {
  contexts: DisplayContextMemory[];
  /** Request epoch of the mount whose responses this list accepts. */
  contextsEpoch: number;
  /** Failure of the query currently on screen, if it never settled. */
  contextsError?: unknown;
  /** Bumped whenever in-flight requests for this list become stale. */
  contextsGeneration: number;
  contextsHasMore: boolean;
  contextsPage: number;
  /** Failure of a load-more page; the rows already on screen stay. */
  contextsPageError?: unknown;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  contextsPageSize?: number;
  /** The page a request is currently outstanding for. */
  contextsPendingPage?: number;
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
  contextsEpoch: 0,
  contextsError: undefined,
  contextsGeneration: 0,
  contextsHasMore: true,
  contextsPage: 1,
  contextsPageError: undefined,
  contextsPageSize: undefined,
  contextsPendingPage: undefined,
  contextsQuery: undefined,
  contextsQueryKey: '',
  contextsSettled: false,
  contextsSort: undefined,
  contextsTotal: 0,
};

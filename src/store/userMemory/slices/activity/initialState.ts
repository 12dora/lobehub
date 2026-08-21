import { type ActivityListItem } from '@lobechat/types';

export interface ActivitySliceState {
  activities: ActivityListItem[];
  /** Failure of the query currently on screen, if it never settled. */
  activitiesError?: unknown;
  /** Bumped whenever in-flight requests for this list become stale. */
  activitiesGeneration: number;
  activitiesHasMore: boolean;
  activitiesPage: number;
  /** Failure of a load-more page; the rows already on screen stay. */
  activitiesPageError?: unknown;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  activitiesPageSize?: number;
  /** The page a request is currently outstanding for. */
  activitiesPendingPage?: number;
  activitiesQuery?: string;
  /** Identity of the query the rows belong to — see `memoryListQueryKey`. */
  activitiesQueryKey: string;
  activitiesSearchLoading?: boolean;
  /** The query on screen has landed at least one page. */
  activitiesSettled: boolean;
  activitiesSort?: 'capturedAt' | 'startsAt';
  activitiesStatus?: string[];
  activitiesTotal: number;
  activitiesTypes?: string[];
}

export const activityInitialState: ActivitySliceState = {
  activities: [],
  activitiesError: undefined,
  activitiesGeneration: 0,
  activitiesHasMore: true,
  activitiesPage: 1,
  activitiesPageError: undefined,
  activitiesPageSize: undefined,
  activitiesPendingPage: undefined,
  activitiesQuery: undefined,
  activitiesQueryKey: '',
  activitiesSearchLoading: undefined,
  activitiesSettled: false,
  activitiesSort: undefined,
  activitiesStatus: undefined,
  activitiesTotal: 0,
  activitiesTypes: undefined,
};

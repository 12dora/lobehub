import { type ActivityListItem } from '@lobechat/types';

export interface ActivitySliceState {
  activities: ActivityListItem[];
  /** Failure of the query currently on screen, if it never settled. */
  activitiesError?: unknown;
  activitiesHasMore: boolean;
  activitiesPage: number;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  activitiesPageSize?: number;
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
  activitiesHasMore: true,
  activitiesPage: 1,
  activitiesPageSize: undefined,
  activitiesQuery: undefined,
  activitiesQueryKey: '',
  activitiesSearchLoading: undefined,
  activitiesSettled: false,
  activitiesSort: undefined,
  activitiesStatus: undefined,
  activitiesTotal: 0,
  activitiesTypes: undefined,
};

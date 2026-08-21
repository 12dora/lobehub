import { type ExperienceListItem } from '@lobechat/types';

export interface ExperienceSliceState {
  experiences: ExperienceListItem[];
  /** Request epoch of the mount whose responses this list accepts. */
  experiencesEpoch: number;
  /** Failure of the query currently on screen, if it never settled. */
  experiencesError?: unknown;
  /** Bumped whenever in-flight requests for this list become stale. */
  experiencesGeneration: number;
  experiencesHasMore: boolean;
  experiencesPage: number;
  /** Failure of a load-more page; the rows already on screen stay. */
  experiencesPageError?: unknown;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  experiencesPageSize?: number;
  /** The page a request is currently outstanding for. */
  experiencesPendingPage?: number;
  experiencesQuery?: string;
  /** Identity of the query the rows belong to — see `memoryListQueryKey`. */
  experiencesQueryKey: string;
  experiencesSearchLoading?: boolean;
  /** The query on screen has landed at least one page. */
  experiencesSettled: boolean;
  experiencesSort?: 'capturedAt' | 'scoreConfidence';
  experiencesTotal: number;
}

export const experienceInitialState: ExperienceSliceState = {
  experiences: [],
  experiencesEpoch: 0,
  experiencesError: undefined,
  experiencesGeneration: 0,
  experiencesHasMore: true,
  experiencesPage: 1,
  experiencesPageError: undefined,
  experiencesPageSize: undefined,
  experiencesPendingPage: undefined,
  experiencesQuery: undefined,
  experiencesQueryKey: '',
  experiencesSettled: false,
  experiencesSort: undefined,
  experiencesTotal: 0,
};

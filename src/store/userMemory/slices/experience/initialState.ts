import { type ExperienceListItem } from '@lobechat/types';

export interface ExperienceSliceState {
  experiences: ExperienceListItem[];
  /** Failure of the query currently on screen, if it never settled. */
  experiencesError?: unknown;
  experiencesHasMore: boolean;
  experiencesPage: number;
  /** Page size of the last fetch, so a post-write refetch can rebuild page 1. */
  experiencesPageSize?: number;
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
  experiencesError: undefined,
  experiencesHasMore: true,
  experiencesPage: 1,
  experiencesPageSize: undefined,
  experiencesQuery: undefined,
  experiencesQueryKey: '',
  experiencesSettled: false,
  experiencesSort: undefined,
  experiencesTotal: 0,
};

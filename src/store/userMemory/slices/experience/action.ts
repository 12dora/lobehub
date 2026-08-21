import { type ExperienceListResult } from '@lobechat/types';
import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { userMemoryKeys } from '@/libs/swr/keys';
import { memoryCRUDService, userMemoryService } from '@/services/userMemory';
import { type StoreSetter } from '@/store/types';
import { setNamespace } from '@/utils/storeDebug';

import { type UserMemoryStore } from '../../store';
import { revalidateMemoryList } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/experience');

export interface ExperienceQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'capturedAt' | 'scoreConfidence';
}

type Setter = StoreSetter<UserMemoryStore>;
export const createExperienceSlice = (set: Setter, get: () => UserMemoryStore, _api?: unknown) =>
  new ExperienceActionImpl(set, get, _api);

export class ExperienceActionImpl {
  readonly #get: () => UserMemoryStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => UserMemoryStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  deleteExperience = async (id: string): Promise<void> => {
    await memoryCRUDService.deleteExperience(id);
    await this.#refreshExperiencesList();
  };

  loadMoreExperiences = (): void => {
    const { experiencesPage, experiencesTotal, experiences } = this.#get();
    if (experiences.length < (experiencesTotal || 0)) {
      this.#set(
        produce((draft) => {
          draft.experiencesPage = experiencesPage + 1;
        }),
        false,
        n('loadMoreExperiences'),
      );
    }
  };

  /**
   * Force a re-read of the list after a write.
   *
   * A mutation doesn't change the query, so it can't go through
   * `resetExperiencesList` (which now no-ops on an unchanged query) and it can't
   * rely on the SWR key changing either. Rewind to page 1 so the accumulated
   * pages can't resurrect a row that was just removed, then revalidate.
   */
  #refreshExperiencesList = async (): Promise<void> => {
    this.#set(
      produce((draft) => {
        draft.experiencesPage = 1;
        draft.experiencesSearchLoading = true;
      }),
      false,
      n('refreshExperiencesList'),
    );

    await revalidateMemoryList(userMemoryKeys.experiences.root);
  };

  resetExperiencesList = (params?: Omit<ExperienceQueryParams, 'page' | 'pageSize'>): void => {
    const state = this.#get();

    // Nothing to reset when the query is the one the store already fetched.
    // The pages call this from a mount effect, so without this guard every
    // visit wiped the rows it had and replaced the list with a skeleton.
    const isSameQuery =
      state.experiencesQuery === params?.q && state.experiencesSort === params?.sort;

    if (isSameQuery && state.experiencesInit) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `experiences`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton), and the page-1 response below
        // replaces them wholesale.
        draft.experiencesPage = 1;
        draft.experiencesQuery = params?.q;
        draft.experiencesSearchLoading = true;
        draft.experiencesSort = params?.sort;
      }),
      false,
      n('resetExperiencesList'),
    );
  };

  useFetchExperiences = (params: ExperienceQueryParams): SWRResponse<ExperienceListResult> => {
    const page = params.page ?? 1;

    return useSWR(
      userMemoryKeys.experiences(params),
      async () => {
        // Use the new dedicated queryExperiences API
        return userMemoryService.queryExperiences({
          page: params.page,
          pageSize: params.pageSize,
          q: params.q,
          sort: params.sort,
        });
      },
      {
        onError: () => {
          // Otherwise the refreshing affordance would spin forever on a failed
          // revalidation.
          this.#set(
            produce((draft) => {
              draft.experiencesSearchLoading = false;
            }),
            false,
            n('useFetchExperiences/onError'),
          );
        },
        onSuccess: (data: ExperienceListResult) => {
          this.#set(
            produce((draft) => {
              draft.experiencesSearchLoading = false;
              draft.experiencesTotal = data.total;

              if (!draft.experiencesInit) {
                draft.experiencesInit = true;
              }

              // Backend now returns flat structure directly, no transformation needed
              if (page === 1) {
                draft.experiences = uniqBy(data.items, 'id');
              } else {
                draft.experiences = uniqBy([...draft.experiences, ...data.items], 'id');
              }

              draft.experiencesHasMore = data.items.length >= (params.pageSize || 20);
            }),
            false,
            n('useFetchExperiences/onSuccess'),
          );
        },
        revalidateOnFocus: false,
      },
    );
  };
}

export type ExperienceAction = Pick<ExperienceActionImpl, keyof ExperienceActionImpl>;

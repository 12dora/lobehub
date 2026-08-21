import { type ExperienceListResult } from '@lobechat/types';
import { uniqBy } from 'es-toolkit/compat';
import { produce } from 'immer';
import { useEffect } from 'react';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { userMemoryKeys } from '@/libs/swr/keys';
import { memoryCRUDService, userMemoryService } from '@/services/userMemory';
import { type StoreSetter } from '@/store/types';
import { setNamespace } from '@/utils/storeDebug';

import { type UserMemoryStore } from '../../store';
import { DEFAULT_MEMORY_LIST_PAGE_SIZE, memoryListQueryKey } from '../../utils/listQuery';
import { dropMemoryListCache } from '../../utils/listRevalidate';

const n = setNamespace('userMemory/experience');

export interface ExperienceQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'capturedAt' | 'scoreConfidence';
}

type ExperienceFilter = Omit<ExperienceQueryParams, 'page' | 'pageSize'>;

/** Every filter field of `ExperienceQueryParams` — pagination excluded. */
const experienceQueryKey = (params?: ExperienceFilter): string =>
  memoryListQueryKey({ q: params?.q, sort: params?.sort });

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
    const {
      experiences,
      experiencesHasMore,
      experiencesPage,
      experiencesSearchLoading,
      experiencesTotal,
    } = this.#get();

    // A reset / refresh is in flight, so the rows on screen still belong to the
    // *previous* query. Bumping the page here would ask for page 2 of the new
    // query and append it to those rows, leaving the list permanently mixed and
    // page 1 of the new query missing. `hasMore` is also latched false across a
    // reset, which stops the virtualized `endReached` from firing at all.
    if (experiencesSearchLoading || !experiencesHasMore) return;
    if (experiences.length >= (experiencesTotal || 0)) return;

    this.#set(
      produce((draft) => {
        draft.experiencesPage = experiencesPage + 1;
      }),
      false,
      n('loadMoreExperiences'),
    );
  };

  /**
   * Re-read the list after a write.
   *
   * A mutation doesn't change the query, so neither `resetExperiencesList` (a
   * no-op on an unchanged query) nor a key change can drive it. Rewind to page
   * 1, drop every cached page of the list, then fetch page 1 here rather than
   * hoping a subscriber revalidates — the store's page and React's subscription
   * move at different times, so "revalidate whatever is subscribed" would have
   * refreshed the page the user happened to be on, not the one the store is
   * about to render.
   */
  #refreshExperiencesList = async (): Promise<void> => {
    const state = this.#get();
    const params: ExperienceQueryParams = {
      page: 1,
      pageSize: state.experiencesPageSize ?? DEFAULT_MEMORY_LIST_PAGE_SIZE,
      q: state.experiencesQuery,
      sort: state.experiencesSort,
    };

    this.#set(
      produce((draft) => {
        draft.experiencesError = undefined;
        draft.experiencesHasMore = false;
        draft.experiencesPage = 1;
        draft.experiencesSearchLoading = true;
        draft.experiencesSettled = false;
      }),
      false,
      n('refreshExperiencesList'),
    );

    await dropMemoryListCache(userMemoryKeys.experiences.root);

    try {
      const data = await userMemoryService.queryExperiences(params);
      this.#applyExperiencesPage(params, data);
    } catch (error) {
      this.#failExperiencesPage(params, error);
    }
  };

  resetExperiencesList = (params?: ExperienceFilter): void => {
    const state = this.#get();
    const nextQueryKey = experienceQueryKey(params);

    // Nothing to reset when the query already settled in the store. The pages
    // call this from a mount effect, so without this guard every visit wiped
    // the rows it had and replaced the list with a skeleton.
    if (nextQueryKey === state.experiencesQueryKey && state.experiencesSettled) return;

    this.#set(
      produce((draft) => {
        // Deliberately keep `experiences`: the rows already on screen stay put
        // while the new query is in flight (the page shows a subtle refreshing
        // affordance instead of a skeleton). They are no longer "settled"
        // though, so nothing may accumulate on top of them until page 1 of the
        // new query lands.
        draft.experiencesError = undefined;
        draft.experiencesHasMore = false;
        draft.experiencesPage = 1;
        draft.experiencesQuery = params?.q;
        draft.experiencesQueryKey = nextQueryKey;
        draft.experiencesSearchLoading = true;
        draft.experiencesSettled = false;
        draft.experiencesSort = params?.sort;
      }),
      false,
      n('resetExperiencesList'),
    );
  };

  useFetchExperiences = (params: ExperienceQueryParams): SWRResponse<ExperienceListResult> => {
    const queryKey = experienceQueryKey(params);
    const page = params.page ?? 1;

    const swr = useSWR(
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
        onError: (error) => this.#failExperiencesPage(params, error),
        revalidateOnFocus: false,
      },
    );

    // Sync SWR → store from an effect rather than `onSuccess`: when the key
    // changes to a page that is already cached, SWR hands the data back without
    // ever running the fetcher, and an `onSuccess`-only store would keep
    // showing the previous query's rows with a spinner that never stops.
    const data = swr.data;
    useEffect(() => {
      if (!data) return;
      this.#applyExperiencesPage(params, data);
    }, [data, queryKey, page]);

    return swr;
  };

  /** Write one page into the list — only if it still belongs to what's on screen. */
  #applyExperiencesPage = (params: ExperienceQueryParams, data: ExperienceListResult): void => {
    const state = this.#get();
    const page = params.page ?? 1;

    if (experienceQueryKey(params) !== state.experiencesQueryKey) return;
    if (page !== state.experiencesPage) return;

    this.#set(
      produce((draft) => {
        draft.experiencesError = undefined;
        draft.experiencesHasMore =
          data.items.length >= (params.pageSize || DEFAULT_MEMORY_LIST_PAGE_SIZE);
        draft.experiencesPageSize = params.pageSize ?? draft.experiencesPageSize;
        draft.experiencesSearchLoading = false;
        draft.experiencesSettled = true;
        draft.experiencesTotal = data.total;

        // Backend now returns flat structure directly, no transformation needed
        draft.experiences =
          page === 1
            ? uniqBy(data.items, 'id')
            : uniqBy([...draft.experiences, ...data.items], 'id');
      }),
      false,
      n('applyExperiencesPage'),
    );
  };

  /** Record a failure for the query on screen so the page can offer a retry. */
  #failExperiencesPage = (params: ExperienceQueryParams, error: unknown): void => {
    if (experienceQueryKey(params) !== this.#get().experiencesQueryKey) return;

    this.#set(
      produce((draft) => {
        draft.experiencesError = error;
        draft.experiencesSearchLoading = false;
      }),
      false,
      n('failExperiencesPage'),
    );
  };
}

export type ExperienceAction = Pick<ExperienceActionImpl, keyof ExperienceActionImpl>;

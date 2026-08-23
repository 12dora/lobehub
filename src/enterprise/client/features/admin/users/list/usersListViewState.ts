import type { AdminUsersListOutput } from '@/enterprise/client/services/adminUsers';

import type { ListQueryState } from './useUsersListQuery';

export interface UsersListViewState {
  /** Any filter narrows the result set — picks the "no match" empty copy over "no users". */
  hasFilters: boolean;
  items: AdminUsersListOutput['items'];
  showError: boolean;
  showLoading: boolean;
  /** Cached rows with a failed revalidation: keep the table, warn above it. */
  showStaleWarning: boolean;
  tableLoading: boolean;
  total: number;
}

/**
 * Everything the table renders from one SWR result. Kept as one function so the
 * loading / error / stale trio is read (and changed) as a single decision.
 */
export const deriveUsersListViewState = (params: {
  data: AdminUsersListOutput | undefined;
  error: unknown;
  isLoading: boolean;
  isValidating: boolean;
  queryState: ListQueryState;
}): UsersListViewState => {
  const { data, error, isLoading, isValidating, queryState } = params;
  const { createdFrom, createdTo, query, role, source, status } = queryState;

  const showLoading = isLoading && !data;

  return {
    hasFilters: Boolean(query || status || role || source || createdFrom || createdTo),
    items: data?.items ?? [],
    showError: Boolean(error) && !data,
    showLoading,
    showStaleWarning: Boolean(error) && Boolean(data),
    tableLoading: showLoading || (isValidating && !data),
    total: data?.total ?? 0,
  };
};

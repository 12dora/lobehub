export interface CommitThenScheduleRefreshOptions<Result> {
  commit: () => Promise<Result>;
  onCommitted?: (result: Result) => void;
  onRefreshed?: () => void;
  onRefreshFailed?: (cause: unknown) => void;
  refresh: () => Promise<unknown>;
}

/**
 * Resolve as soon as the write commits, then refresh in a separate microtask.
 * A failed refresh can never turn a committed write into a mutation failure/retry prompt.
 */
export const commitThenScheduleRefresh = async <Result>({
  commit,
  onCommitted,
  onRefreshFailed,
  onRefreshed,
  refresh,
}: CommitThenScheduleRefreshOptions<Result>): Promise<Result> => {
  const result = await commit();
  onCommitted?.(result);
  void Promise.resolve().then(refresh).then(onRefreshed, onRefreshFailed);
  return result;
};

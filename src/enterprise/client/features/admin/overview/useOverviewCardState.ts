export type OverviewCardStateKey = 'data' | 'empty' | 'error' | 'loading';

export interface OverviewCardStateInput {
  data: unknown;
  empty: boolean;
  error: unknown;
  isLoading: boolean;
}

export interface OverviewCardStateResult {
  empty: boolean;
  firstError: boolean;
  loading: boolean;
  staleError: boolean;
  stateKey: OverviewCardStateKey;
}

export const overviewCardState = ({
  data,
  empty,
  error,
  isLoading,
}: OverviewCardStateInput): OverviewCardStateResult => {
  const loading = isLoading && !data;
  const firstError = Boolean(error && !data);
  const staleError = Boolean(error && data);
  const isEmpty = !loading && !firstError && empty;

  return {
    empty: isEmpty,
    firstError,
    loading,
    staleError,
    stateKey: loading ? 'loading' : firstError ? 'error' : isEmpty ? 'empty' : 'data',
  };
};

import { useMemo } from 'react';

import type { ViewMode } from '@/routes/(main)/resource/features/store/initialState';

interface UseMasonryViewStateOptions {
  dataLength: number;
  isLoading: boolean;
  isNavigating: boolean;
  isValidating: boolean;
  viewMode: ViewMode;
}

export const useMasonryViewState = ({
  dataLength,
  isLoading,
  isNavigating,
  isValidating: _isValidating,
  viewMode: _viewMode,
}: UseMasonryViewStateOptions) => {
  // The skeleton is for an empty screen only. Navigating between categories /
  // libraries used to force it even though the previous folder's cards were
  // still in hand, so every switch blanked the grid and re-laid it out. Keep
  // those cards on screen and dim them while the new query resolves; a genuine
  // space switch clears the store first (see `setListVisibility`), so it lands
  // on `dataLength === 0` and still gets the skeleton it needs.
  const showSkeleton = useMemo(
    () => (isLoading || isNavigating) && dataLength === 0,
    [dataLength, isLoading, isNavigating],
  );

  /** Previous cards are still rendered while the next query is in flight. */
  const isRefreshing = useMemo(() => isNavigating && dataLength > 0, [dataLength, isNavigating]);

  const isMasonryReady = !showSkeleton;

  return {
    isMasonryReady,
    isRefreshing,
    showSkeleton,
  };
};

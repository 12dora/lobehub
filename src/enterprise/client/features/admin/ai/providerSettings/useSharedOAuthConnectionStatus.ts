'use client';

import { useCallback } from 'react';

import { useClientDataSWR } from '@/libs/swr';
import { lambdaClient } from '@/libs/trpc/client';
import { useAiInfraStoreApi } from '@/store/aiInfra';

import { buildAdminSharedOAuthStatusKey } from './sharedOAuthFormat';

/**
 * The stored shared-account connection, plus the revalidation fan-out every write on this
 * panel has to trigger. Both live together because the fan-out is what makes the read
 * trustworthy: the credential write changes the provider row and the runtime state too.
 */
export const useSharedOAuthConnectionStatus = (providerId: string) => {
  const storeApi = useAiInfraStoreApi();

  const statusKey = buildAdminSharedOAuthStatusKey(providerId);
  const {
    data: status,
    error: statusError,
    isLoading,
    mutate: refreshStatus,
  } = useClientDataSWR(
    statusKey,
    () => lambdaClient.admin.aiProviderOAuth.getConnectionStatus.query({ id: providerId }),
    { revalidateOnFocus: false },
  );

  const handleStored = useCallback(async () => {
    // The write is already committed server-side; a failing refresh must not be reported as
    // a failed write — the panel keeps its outcome state either way.
    try {
      const state = storeApi.getState();
      /**
       * allSettled, NOT a sequential await chain: these four reads are independent, and one
       * rejection used to skip every later refresh. The runtime-state read is the one that
       * must not be skipped — it drives the header EnableSwitch and the provider grid, both
       * of which would keep showing a provider this write just turned off.
       *
       * refreshStatus uses the bound mutate: useClientDataSWR augments the key with the
       * workspace id.
       */
      await Promise.allSettled([
        refreshStatus(),
        state.refreshAiProviderDetail(),
        state.refreshAiProviderList(),
        state.refreshAiProviderRuntimeState(),
      ]);
    } catch {
      /* stale view only; the next revalidation recovers it */
    }
  }, [refreshStatus, storeApi]);

  const handleStatusStale = useCallback(() => {
    // A cancelled/expired/failed flow can still sit on a connection the server stored:
    // re-read the status instead of leaving the idle card on the pre-connect answer.
    // Wrapped because a failing revalidation is a stale view only, never a user error.
    void Promise.resolve(refreshStatus()).catch(() => {});
  }, [refreshStatus]);

  return { handleStatusStale, handleStored, isLoading, refreshStatus, status, statusError };
};

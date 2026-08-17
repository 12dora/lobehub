'use client';

import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';
import { ADMIN_POLL_INTERVALS } from '@/enterprise/client/shared/pollIntervals';
import { useVisiblePoll } from '@/enterprise/client/shared/useVisiblePoll';
import { useClientDataSWR } from '@/libs/swr';

import { isIdentityProviderTestTerminal } from './controller';

export const IDENTITY_PROVIDER_LIST_PAGE_SIZE = 100;

export const useIdentityProviders = (enabled: boolean, cursor?: string) =>
  useClientDataSWR(
    enabled ? (['admin.identityProviders.list', cursor ?? null] as const) : null,
    () =>
      adminIdentityProvidersService.list({
        cursor,
        limit: IDENTITY_PROVIDER_LIST_PAGE_SIZE,
      }),
    { revalidateOnFocus: false },
  );

export const useIdentityProviderCallbacks = (enabled: boolean) =>
  useClientDataSWR(
    enabled ? ['admin.identityProviders.callbacks'] : null,
    () => adminIdentityProvidersService.getCallbackUrls(),
    { revalidateOnFocus: false },
  );

export const useIdentityProviderTestResult = (
  attemptId: string | null,
  poll: boolean,
  onTerminal: () => void,
) => {
  // Nobody is reading a test result in a background tab; the poll resumes (and the terminal
  // callback fires) within one cadence of the tab coming back.
  const refreshInterval = useVisiblePoll(ADMIN_POLL_INTERVALS.identityProviderRestart, poll);
  return useClientDataSWR(
    attemptId ? ['admin.identityProviders.testResult', attemptId] : null,
    () => adminIdentityProvidersService.testResult(attemptId!),
    {
      refreshInterval,
      revalidateOnFocus: false,
      onSuccess: (data) => {
        if (isIdentityProviderTestTerminal(data.status)) onTerminal();
      },
    },
  );
};

export const useAuthSnapshotStatus = (enabled: boolean, poll: boolean) => {
  const refreshInterval = useVisiblePoll(ADMIN_POLL_INTERVALS.identityProviderSnapshot, poll);
  return useClientDataSWR(
    enabled ? ['admin.system.authSnapshotStatus'] : null,
    () => adminIdentityProvidersService.getAuthSnapshotStatus(),
    {
      refreshInterval,
      revalidateOnFocus: false,
    },
  );
};

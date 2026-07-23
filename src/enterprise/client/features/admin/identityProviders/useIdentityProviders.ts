'use client';

import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';
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
) =>
  useClientDataSWR(
    attemptId ? ['admin.identityProviders.testResult', attemptId] : null,
    () => adminIdentityProvidersService.testResult(attemptId!),
    {
      refreshInterval: poll ? 1500 : 0,
      revalidateOnFocus: false,
      onSuccess: (data) => {
        if (isIdentityProviderTestTerminal(data.status)) onTerminal();
      },
    },
  );

export const useIdentityProviderRevisionHistory = (id: string | undefined, enabled: boolean) =>
  useClientDataSWR(
    enabled && id ? ['admin.identityProviders.revisions', id] : null,
    () => adminIdentityProvidersService.listPublishedRevisions(id!),
    { revalidateOnFocus: false },
  );

export const useAuthSnapshotStatus = (enabled: boolean, poll: boolean) =>
  useClientDataSWR(
    enabled ? ['admin.system.authSnapshotStatus'] : null,
    () => adminIdentityProvidersService.getAuthSnapshotStatus(),
    { refreshInterval: poll ? 2000 : 0, revalidateOnFocus: false },
  );

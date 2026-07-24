'use client';

import { adminManagedResourcesService } from '@/enterprise/client/services/adminManagedResources';
import { useClientDataSWR } from '@/libs/swr';

import { buildAdminManagedResourcesKey } from '../swrKeys';

export const useFetchAdminManagedResources = (enabled = true) => {
  return useClientDataSWR(
    enabled ? buildAdminManagedResourcesKey() : null,
    () => adminManagedResourcesService.get(),
    { revalidateOnFocus: false },
  );
};

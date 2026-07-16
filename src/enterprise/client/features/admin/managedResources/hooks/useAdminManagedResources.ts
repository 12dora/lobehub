'use client';

import { mutate } from 'swr';

import { adminManagedResourcesService } from '@/enterprise/client/services/adminManagedResources';
import { useClientDataSWR } from '@/libs/swr';

import { ADMIN_MANAGED_RESOURCES_KEY, buildAdminManagedResourcesKey } from '../swrKeys';

export const useFetchAdminManagedResources = (enabled = true) => {
  return useClientDataSWR(
    enabled ? buildAdminManagedResourcesKey() : null,
    () => adminManagedResourcesService.get(),
    { revalidateOnFocus: false },
  );
};

export const refreshAdminManagedResources = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_MANAGED_RESOURCES_KEY);
};

'use client';

import { mutate } from 'swr';

import { platformConnectorsService } from '@/enterprise/client/services/platformConnectors';
import { useClientDataSWR } from '@/libs/swr';

import { buildManagedConnectorListKey, MANAGED_CONNECTOR_LIST_KEY } from './swrKeys';
import type { UserConnectorListInput } from './types';

export const useFetchManagedConnectors = (input: UserConnectorListInput) =>
  useClientDataSWR(
    buildManagedConnectorListKey(input),
    () => platformConnectorsService.listManaged(input),
    { revalidateOnFocus: false },
  );

export const refreshManagedConnectorLists = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === MANAGED_CONNECTOR_LIST_KEY);
};

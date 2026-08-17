'use client';

import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import { mutate, useClientDataSWR } from '@/libs/swr';

import {
  ADMIN_CONNECTOR_LIST_KEY,
  buildAdminConnectorGetKey,
  buildAdminConnectorListKey,
} from './swrKeys';
import type { AdminConnectorCatalogClient, AdminConnectorListInput } from './types';

/** Production uses the real typed lambda adapter; tests may inject an explicit contract client. */
export const useFetchAdminConnectors = (
  input: AdminConnectorListInput,
  enabled: boolean,
  client: AdminConnectorCatalogClient = adminConnectorsService,
) =>
  useClientDataSWR(buildAdminConnectorListKey(input, enabled), () => client.list(input), {
    revalidateOnFocus: false,
  });

export const useFetchAdminConnector = (
  id: string | undefined,
  enabled: boolean,
  client: AdminConnectorCatalogClient = adminConnectorsService,
) =>
  useClientDataSWR(buildAdminConnectorGetKey(id, enabled), () => client.get({ id: id! }), {
    revalidateOnFocus: false,
  });

export const refreshAdminConnectorLists = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_CONNECTOR_LIST_KEY);
};

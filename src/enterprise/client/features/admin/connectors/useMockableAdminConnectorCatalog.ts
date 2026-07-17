'use client';

import { mutate } from 'swr';

import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import { useClientDataSWR } from '@/libs/swr';

import {
  ADMIN_CONNECTOR_GET_KEY,
  ADMIN_CONNECTOR_LIST_KEY,
  buildAdminConnectorGetKey,
  buildAdminConnectorListKey,
} from './swrKeys';
import type { AdminConnectorCatalogClient, AdminConnectorListInput } from './types';

/**
 * Contract-first hook. PR-046 injects a Mock client until the server mounts admin.connectors;
 * production wiring must pass the real typed lambdaClient adapter later.
 */
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

/** Test-only injection aliases kept for contract mocks; production callers use the real defaults. */
export const useFetchMockableAdminConnectors = (
  client: AdminConnectorCatalogClient,
  input: AdminConnectorListInput,
  enabled: boolean,
) => useFetchAdminConnectors(input, enabled, client);

export const useFetchMockableAdminConnector = (
  client: AdminConnectorCatalogClient,
  id: string | undefined,
  enabled: boolean,
) => useFetchAdminConnector(id, enabled, client);

export const refreshAdminConnectorLists = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_CONNECTOR_LIST_KEY);
};

export const refreshAdminConnector = async (id: string) => {
  const [detail] = await Promise.all([
    mutate(buildAdminConnectorGetKey(id, true)),
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_CONNECTOR_LIST_KEY),
  ]);
  return detail;
};

export const clearAdminConnectorCache = async () => {
  await mutate(
    (key) =>
      Array.isArray(key) &&
      (key[0] === ADMIN_CONNECTOR_GET_KEY || key[0] === ADMIN_CONNECTOR_LIST_KEY),
    undefined,
    { revalidate: false },
  );
};

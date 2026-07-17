'use client';

import { useClientDataSWR } from '@/libs/swr';

import { buildAdminConnectorGetKey, buildAdminConnectorListKey } from './swrKeys';
import type { AdminConnectorCatalogClient, AdminConnectorListInput } from './types';

/**
 * Contract-first hook. PR-046 injects a Mock client until the server mounts admin.connectors;
 * production wiring must pass the real typed lambdaClient adapter later.
 */
export const useFetchMockableAdminConnectors = (
  client: AdminConnectorCatalogClient,
  input: AdminConnectorListInput,
  enabled: boolean,
) =>
  useClientDataSWR(buildAdminConnectorListKey(input, enabled), () => client.list(input), {
    revalidateOnFocus: false,
  });

export const useFetchMockableAdminConnector = (
  client: AdminConnectorCatalogClient,
  id: string | undefined,
  enabled: boolean,
) =>
  useClientDataSWR(buildAdminConnectorGetKey(id, enabled), () => client.get({ id: id! }), {
    revalidateOnFocus: false,
  });

'use client';

import { adminAiProviderService } from '@/enterprise/client/services/adminAiInfraAdapter';
import {
  type AdminNetworkProxyService,
  adminNetworkProxyService,
} from '@/enterprise/client/services/adminNetworkProxy';
import { mutate, useClientDataSWR } from '@/libs/swr';

import {
  buildNetworkProxyArtifactsKey,
  buildNetworkProxyLogsKey,
  buildNetworkProxyNodesKey,
  buildNetworkProxyProviderCatalogKey,
  buildNetworkProxySettingsKey,
  buildNetworkProxyStatusKey,
  buildNetworkProxySubscriptionsKey,
  NETWORK_PROXY_ARTIFACTS_KEY,
  NETWORK_PROXY_LOGS_KEY,
  NETWORK_PROXY_NODES_KEY,
  NETWORK_PROXY_STATUS_KEY,
  NETWORK_PROXY_SUBSCRIPTIONS_KEY,
} from './swrKeys';

/** Live status is the page's only auto-refreshing query — everything else is event driven. */
export const NETWORK_PROXY_STATUS_REFRESH_MS = 15_000;

export const useNetworkProxySettings = (
  enabled: boolean,
  service: AdminNetworkProxyService = adminNetworkProxyService,
) =>
  useClientDataSWR(buildNetworkProxySettingsKey(enabled), () => service.getSettings(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

export const useNetworkProxyStatus = (
  enabled: boolean,
  service: AdminNetworkProxyService = adminNetworkProxyService,
) =>
  useClientDataSWR(buildNetworkProxyStatusKey(enabled), () => service.getStatus(), {
    keepPreviousData: true,
    refreshInterval: NETWORK_PROXY_STATUS_REFRESH_MS,
    revalidateOnFocus: false,
  });

export const useNetworkProxySubscriptions = (
  enabled: boolean,
  service: AdminNetworkProxyService = adminNetworkProxyService,
) =>
  useClientDataSWR(buildNetworkProxySubscriptionsKey(enabled), () => service.listSubscriptions(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

export const useNetworkProxyNodes = (
  enabled: boolean,
  service: AdminNetworkProxyService = adminNetworkProxyService,
) =>
  useClientDataSWR(buildNetworkProxyNodesKey(enabled), () => service.listNodes(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

export const useNetworkProxyArtifacts = (
  enabled: boolean,
  service: AdminNetworkProxyService = adminNetworkProxyService,
) =>
  useClientDataSWR(buildNetworkProxyArtifactsKey(enabled), () => service.getArtifactStatus(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

/** Only fetched while the logs drawer is open — the lines come from one instance's ring buffer. */
export const useNetworkProxyEngineLogs = (
  enabled: boolean,
  service: AdminNetworkProxyService = adminNetworkProxyService,
) =>
  useClientDataSWR(buildNetworkProxyLogsKey(enabled), () => service.getEngineLogs(), {
    revalidateOnFocus: false,
  });

export interface NetworkProxyProviderOption {
  /** Enabled in the platform AI catalog — a disabled provider can still be scoped ahead of time. */
  enabled: boolean;
  id: string;
  name: string;
}

/**
 * Providers the scope table offers. Same source as the admin 服务商 page: platform catalog rows
 * merged with the built-in `DEFAULT_MODEL_PROVIDER_LIST`, so the admin sees every provider a
 * user can pick. Failure is surfaced inline — the feature table and the already-scoped providers
 * still render.
 */
export const useNetworkProxyProviderCatalog = (enabled: boolean) =>
  useClientDataSWR(
    buildNetworkProxyProviderCatalogKey(enabled),
    async (): Promise<NetworkProxyProviderOption[]> => {
      const list = await adminAiProviderService.getAiProviderList();
      return list.map((provider) => ({
        enabled: Boolean(provider.enabled),
        id: provider.id,
        name: provider.name || provider.id,
      }));
    },
    { keepPreviousData: true, revalidateOnFocus: false },
  );

export const invalidateNetworkProxySubscriptions = () =>
  mutate((key) => Array.isArray(key) && key[0] === NETWORK_PROXY_SUBSCRIPTIONS_KEY);

export const invalidateNetworkProxyNodes = () =>
  mutate((key) => Array.isArray(key) && key[0] === NETWORK_PROXY_NODES_KEY);

/**
 * Per-instance install and engine state come from `getStatus`, which otherwise only refreshes on
 * its 15 s poll — an install has to make its own result visible.
 */
export const invalidateNetworkProxyStatus = () =>
  mutate((key) => Array.isArray(key) && key[0] === NETWORK_PROXY_STATUS_KEY);

export const invalidateNetworkProxyEngine = () =>
  mutate(
    (key) =>
      Array.isArray(key) &&
      (key[0] === NETWORK_PROXY_ARTIFACTS_KEY || key[0] === NETWORK_PROXY_LOGS_KEY),
  );

export const NETWORK_PROXY_SETTINGS_KEY = 'admin.networkProxy.getSettings';
export const NETWORK_PROXY_STATUS_KEY = 'admin.networkProxy.getStatus';
export const NETWORK_PROXY_SUBSCRIPTIONS_KEY = 'admin.networkProxy.listSubscriptions';
export const NETWORK_PROXY_NODES_KEY = 'admin.networkProxy.listNodes';
export const NETWORK_PROXY_ARTIFACTS_KEY = 'admin.networkProxy.getArtifactStatus';
export const NETWORK_PROXY_LOGS_KEY = 'admin.networkProxy.getEngineLogs';

/** `null` disables the query — SWR never fires for an admin without NETWORK_PROXY_READ. */
export const buildNetworkProxySettingsKey = (enabled: boolean) =>
  enabled ? ([NETWORK_PROXY_SETTINGS_KEY] as const) : null;

export const buildNetworkProxyStatusKey = (enabled: boolean) =>
  enabled ? ([NETWORK_PROXY_STATUS_KEY] as const) : null;

export const buildNetworkProxySubscriptionsKey = (enabled: boolean) =>
  enabled ? ([NETWORK_PROXY_SUBSCRIPTIONS_KEY] as const) : null;

export const buildNetworkProxyNodesKey = (enabled: boolean) =>
  enabled ? ([NETWORK_PROXY_NODES_KEY] as const) : null;

export const buildNetworkProxyArtifactsKey = (enabled: boolean) =>
  enabled ? ([NETWORK_PROXY_ARTIFACTS_KEY] as const) : null;

export const buildNetworkProxyLogsKey = (enabled: boolean) =>
  enabled ? ([NETWORK_PROXY_LOGS_KEY] as const) : null;

/** The admin AI catalog provider list feeding the 服务商 scope table. */
export const NETWORK_PROXY_PROVIDER_CATALOG_KEY = 'admin.networkProxy.providerCatalog';

export const buildNetworkProxyProviderCatalogKey = (enabled: boolean) =>
  enabled ? ([NETWORK_PROXY_PROVIDER_CATALOG_KEY] as const) : null;

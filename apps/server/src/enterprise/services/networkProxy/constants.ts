/**
 * Audit action / target tokens and singleton id for network proxy.
 *
 * B4 registers these in `auditActionCatalog.ts` + locale labels.
 */
export const NETWORK_PROXY_AUDIT_ACTIONS = {
  ENGINE_INSTALL: 'network_proxy.engine.install',
  ENGINE_RESTART: 'network_proxy.engine.restart',
  GEODATA_INSTALL: 'network_proxy.geodata.install',
  OUTLET_SELECT_NODE: 'network_proxy.outlet.select_node',
  SCOPES_UPDATE: 'network_proxy.scopes.update',
  SETTINGS_UPDATE: 'network_proxy.settings.update',
  SUBSCRIPTION_CREATE: 'network_proxy.subscription.create',
  SUBSCRIPTION_DELETE: 'network_proxy.subscription.delete',
  SUBSCRIPTION_REFRESH: 'network_proxy.subscription.refresh',
  SUBSCRIPTION_UPDATE: 'network_proxy.subscription.update',
} as const;

export type NetworkProxyAuditAction =
  (typeof NETWORK_PROXY_AUDIT_ACTIONS)[keyof typeof NETWORK_PROXY_AUDIT_ACTIONS];

export const NETWORK_PROXY_AUDIT_TARGET_TYPES = {
  ENGINE: 'network_proxy_engine',
  SETTINGS: 'network_proxy_settings',
  SUBSCRIPTION: 'network_proxy_subscription',
} as const;

export type NetworkProxyAuditTargetType =
  (typeof NETWORK_PROXY_AUDIT_TARGET_TYPES)[keyof typeof NETWORK_PROXY_AUDIT_TARGET_TYPES];

export const NETWORK_PROXY_SETTINGS_ID = 'default';

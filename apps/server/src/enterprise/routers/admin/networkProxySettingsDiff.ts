import { createHash } from 'node:crypto';

import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';
import type {
  DesiredArtifacts,
  NetworkProxyArtifactKind,
  NetworkProxyConfig,
  NetworkProxyConfigUpdate,
  OutletConfig,
  SubscriptionView,
} from '@/types/platform/networkProxy';

import type {
  AdminNetworkProxyLocalOutcome,
  AdminNetworkProxySettingsMutationOutput,
  AdminNetworkProxySettingsOutput,
} from '../../contracts/adminNetworkProxy';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
import { NETWORK_PROXY_AUDIT_ACTIONS as B1_AUDIT_ACTIONS } from '../../services/networkProxy/constants';
import { redactSecrets } from '../../services/networkProxy/redact';
import type { NetworkProxyRuntime, NetworkProxySettingsRow } from './networkProxyRuntime';

const NETWORK_PROXY_AUDIT_ACTIONS = B1_AUDIT_ACTIONS as typeof B1_AUDIT_ACTIONS &
  Record<keyof typeof B1_AUDIT_ACTIONS, AuditAction>;

export const toSettingsOutput = (
  row: NetworkProxySettingsRow,
  runtime: Pick<NetworkProxyRuntime, 'isLegacyGlobalProxyActive' | 'toNetworkProxyConfigView'>,
): AdminNetworkProxySettingsOutput => ({
  config: runtime.toNetworkProxyConfigView(row.config),
  desiredArtifacts: row.desiredArtifacts,
  engineGeneration: row.engineGeneration,
  globalProxyActive: runtime.isLegacyGlobalProxyActive(),
  revision: row.revision,
});

export const toSettingsMutationOutput = (
  row: NetworkProxySettingsRow,
  runtime: Pick<NetworkProxyRuntime, 'isLegacyGlobalProxyActive' | 'toNetworkProxyConfigView'>,
  local: AdminNetworkProxyLocalOutcome,
): AdminNetworkProxySettingsMutationOutput => ({
  ...toSettingsOutput(row, runtime),
  local,
});

/** First 12 hex chars of sha256 — audit-safe stand-in for a node / label. */
export const hashNameForAudit = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);

const sameStringArray = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameOutlet = (left: OutletConfig, right: OutletConfig): boolean =>
  left.kind === right.kind &&
  left.mode === right.mode &&
  left.latencyIntervalSec === right.latencyIntervalSec &&
  left.latencyTestUrl === right.latencyTestUrl &&
  left.toleranceMs === right.toleranceMs &&
  (left.manualNodeName ?? undefined) === (right.manualNodeName ?? undefined);

/**
 * Dangerous when the write can change where the whole site egresses
 * (`masterEnabled` / `outlet` / `staticProxy` / `ruleMode` / `bypassHosts`).
 */
export const isDangerousSettingsUpdate = (
  current: NetworkProxyConfig,
  update: NetworkProxyConfigUpdate,
): boolean => {
  if (current.masterEnabled !== update.masterEnabled) return true;
  if (current.ruleMode !== update.ruleMode) return true;
  if (!sameStringArray(current.bypassHosts, update.bypassHosts)) return true;
  if (!sameOutlet(current.outlet, update.outlet)) return true;

  if (update.staticProxy === null) return Boolean(current.staticProxy);
  if (!current.staticProxy) return true;
  if (update.staticProxy.password.action !== 'keep') return true;
  return (
    current.staticProxy.type !== update.staticProxy.type ||
    current.staticProxy.server !== update.staticProxy.server ||
    current.staticProxy.port !== update.staticProxy.port ||
    (current.staticProxy.username ?? undefined) !== (update.staticProxy.username ?? undefined)
  );
};

export const summarizeSettingsAfterDiff = (next: NetworkProxyConfig, revision: number) => ({
  bypassHostCount: next.bypassHosts.length,
  hasStaticProxy: Boolean(next.staticProxy),
  masterEnabled: next.masterEnabled,
  outletKind: next.outlet.kind,
  outletMode: next.outlet.mode,
  revision,
  ruleMode: next.ruleMode,
});

const countEnabled = (states: Record<string, { enabled: boolean }>): number =>
  Object.values(states).filter((state) => state.enabled).length;

export const summarizeScopesAfterDiff = (
  next: NetworkProxyConfig,
  opCount: number,
  revision: number,
) => ({
  featureEnabledCount: countEnabled(next.scopes.features),
  opCount,
  providerEnabledCount: countEnabled(next.scopes.providers),
  revision,
});

export const summarizeSubscriptionAfterDiff = (
  view: Pick<SubscriptionView, 'id' | 'kind' | 'name' | 'urlHost'>,
  redact: (text: string) => string = redactSecrets,
) => ({
  id: view.id,
  kind: view.kind,
  name: redact(view.name),
  urlHost: view.urlHost === null ? null : redact(view.urlHost),
});

export const desiredArtifactsPatchFor = (
  kind: NetworkProxyArtifactKind,
  requestedAt: string,
): DesiredArtifacts => {
  if (kind === 'engine') {
    return { engine: { requestedAt, version: NETWORK_PROXY_ENGINE_MANIFEST.version } };
  }
  const commit = NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit;
  return kind === 'geoip'
    ? { geoip: { commit, requestedAt } }
    : { geosite: { commit, requestedAt } };
};

export const installAuditActionFor = (kind: NetworkProxyArtifactKind) =>
  kind === 'engine'
    ? NETWORK_PROXY_AUDIT_ACTIONS.ENGINE_INSTALL
    : NETWORK_PROXY_AUDIT_ACTIONS.GEODATA_INSTALL;

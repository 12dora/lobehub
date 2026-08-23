import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminNetworkProxyConnectivity,
  AdminNetworkProxyNodeList,
  AdminNetworkProxyService,
  AdminNetworkProxySettings,
} from '@/enterprise/client/services/adminNetworkProxy';
import type {
  EgressScopeOp,
  NetworkProxyArtifactKind,
  NetworkProxyConfigUpdate,
  SubscriptionCreate,
  SubscriptionUpdate,
} from '@/types/platform/networkProxy';

/**
 * Field ids. Every instant-save control owns one, so a failure on one control never disables,
 * clears or rolls back another. Ids are stable strings because scope / subscription / node fields
 * are keyed by a runtime id.
 */
export const NETWORK_PROXY_FIELDS = {
  bypassHosts: 'bypassHosts',
  connectivity: 'connectivity',
  downloadViaStaticProxy: 'downloadViaStaticProxy',
  install: (kind: NetworkProxyArtifactKind) => `install:${kind}`,
  installGeodata: 'install:geodata',
  latency: 'latency',
  master: 'master',
  nodeLatency: (nodeName: string) => `latency:${nodeName}`,
  outletKind: 'outlet.kind',
  outletLatencyInterval: 'outlet.latencyIntervalSec',
  outletLatencyUrl: 'outlet.latencyTestUrl',
  outletMode: 'outlet.mode',
  outletTolerance: 'outlet.toleranceMs',
  restart: 'restart',
  ruleMode: 'ruleMode',
  scope: (scopeId: string, part: 'enabled' | 'onUnavailable') => `scope:${scopeId}:${part}`,
  scopesBulk: 'scopes.bulk',
  selectNode: 'selectNode',
  staticProxy: 'staticProxy',
  subscription: (id: string) => `subscription:${id}`,
  subscriptionCreate: 'subscription.create',
  subscriptionUpdateViaOutlet: 'subscriptionUpdateViaOutlet',
} as const;

export type NetworkProxyFieldId = string;

/** `conflict` is an error too — it is split out because its copy and recovery differ. */
export type NetworkProxyEntryStatus = 'conflict' | 'error' | 'pending' | 'success';

export interface NetworkProxyEntry {
  /**
   * `admin` namespace key naming the engine issue behind the failure, when the server classified
   * one (contract I2). Rendered under `errorKey` — never a raw server message.
   */
  detailKey?: string;
  /**
   * The value the admin chose, kept while the write is in flight and after it fails, so a
   * failure never silently snaps the control back to the server value (design §6).
   * Absent once the write commits — the server bundle is then the truth.
   */
  draft?: unknown;
  /** `admin` namespace key describing the failure. Set for `error` and `conflict`. */
  errorKey?: string;
  /** Re-run the exact same write against whatever revision is current now. */
  retry?: () => Promise<void>;
  status: NetworkProxyEntryStatus;
}

/** Minimal seam over the settings SWR entry so the hook is testable without SWR. */
export interface NetworkProxySettingsStore {
  /** Replace the cached bundle with the authoritative one a write returned. */
  apply: (next: AdminNetworkProxySettings) => void;
  data?: AdminNetworkProxySettings;
  /**
   * Refetch and return the winning bundle. The conflict retry uses the returned value directly
   * rather than waiting for a re-render, so a retry can never re-send the stale revision.
   */
  reload: () => Promise<AdminNetworkProxySettings | undefined>;
}

export interface UseNetworkProxyActionsOptions {
  authMethod?: AdminReauthAuthMethod | null;
  service?: AdminNetworkProxyService;
  settings: NetworkProxySettingsStore;
}

/** A settings write expressed against the *freshest* bundle, so a retry cannot resurrect stale fields. */
export type NetworkProxySettingsWrite = (
  base: AdminNetworkProxySettings,
) => Promise<AdminNetworkProxySettings>;

export interface NetworkProxyActions {
  /** Field ids whose last write lost a CAS race and is waiting for Retry. */
  conflicts: NetworkProxyFieldId[];
  /** Drop a failed write: the draft disappears and the server value is shown again. */
  dismiss: (field: NetworkProxyFieldId) => void;
  dismissAll: () => void;
  entryOf: (field: NetworkProxyFieldId) => NetworkProxyEntry | undefined;
  installArtifact: (kind: NetworkProxyArtifactKind) => Promise<void>;
  /** One action for both smart-routing rule files (contract I3). */
  installGeodata: () => Promise<void>;
  isBusy: (field: NetworkProxyFieldId) => boolean;
  lastConnectivity: AdminNetworkProxyConnectivity | null;
  latestNodes: AdminNetworkProxyNodeList | null;
  patchConfig: (
    field: NetworkProxyFieldId,
    draft: unknown,
    build: (base: AdminNetworkProxySettings) => NetworkProxyConfigUpdate,
  ) => Promise<void>;
  restartEngine: () => Promise<void>;
  /** Re-run one failed write. */
  retry: (field: NetworkProxyFieldId) => Promise<void>;
  retryAll: () => Promise<void>;
  selectNode: (nodeName: string) => Promise<void>;
  testConnectivity: () => Promise<void>;
  testLatency: (nodeName?: string) => Promise<void>;
  updateScopes: (field: NetworkProxyFieldId, draft: unknown, ops: EgressScopeOp[]) => Promise<void>;
  /** The value to render for `field`: the admin's uncommitted choice, else the server value. */
  valueOf: <T>(field: NetworkProxyFieldId, serverValue: T) => T;
}

export interface NetworkProxySubscriptionActions {
  create: (input: SubscriptionCreate) => Promise<boolean>;
  refresh: (id: string) => Promise<boolean>;
  remove: (input: { id: string; reason?: string }) => Promise<boolean>;
  update: (input: SubscriptionUpdate) => Promise<boolean>;
}

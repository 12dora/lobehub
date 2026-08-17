/**
 * Re-exports of the B1 data-layer contracts the engine layer consumes.
 * Kept as a single import site so engine files stay off B1 internals.
 */
export type { InstanceStatusUpsert } from '../instanceStatusService';
export { upsertInstanceStatus } from '../instanceStatusService';
export { redactSecrets, redactUrlForDisplay } from '../redact';
export { isLegacyGlobalProxyActive } from '../settingsService';
export type { NetworkProxyRuntimeSnapshot, SubscriptionRuntime } from '../snapshot';
export {
  getNetworkProxySnapshot,
  onNetworkProxySnapshotChange,
  peekNetworkProxySnapshot,
} from '../snapshot';
export {
  parseSubscriptionUserinfoHeader,
  recordSubscriptionFetchResult,
} from '../subscriptionsService';

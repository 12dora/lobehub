/**
 * Process-wide registry for the network-proxy egress layer.
 *
 * `packages/ssrf-safe-fetch` and other OSS modules must not import enterprise
 * code. They read this binding through
 * `Symbol.for('aihub.networkProxy.egressBinding')`.
 *
 * Shape:
 *   {
 *     getProxyUrlFor(url: string): string | null;
 *     getCurrentScope(): EgressScopeId | null;
 *     createEgressFetch(scope): typeof fetch;
 *     runWithEgressScope(scope, fn);
 *     wrapRuntimeWithEgressScope(runtime, scope);
 *     getEgressProxyUrlForCurl(scope, target);
 *     createEgressSafeOutboundTransport(scope);
 *   }
 */
import type { EgressScopeId } from '@/const/platform/networkProxy';
import type {
  PinnedStreamingTransport,
  PinnedTransport,
} from '@/server/enterprise/security/outboundHttp';

export const NETWORK_PROXY_EGRESS_BINDING = Symbol.for('aihub.networkProxy.egressBinding');

export interface NetworkProxyEgressBinding {
  createEgressFetch: (scope: EgressScopeId) => typeof fetch;
  createEgressSafeOutboundTransport: (scope: EgressScopeId) => {
    streamingTransport: PinnedStreamingTransport;
    transport: PinnedTransport;
  };
  getCurrentScope: () => EgressScopeId | null;
  getEgressProxyUrlForCurl: (scope: EgressScopeId, target: string) => Promise<string | null>;
  /**
   * Sync decision for ssrf-safe-fetch. Returns the proxy URL, `null` for
   * direct, and **throws** `NetworkProxyUnavailableError` on `fail`.
   */
  getProxyUrlFor: (url: string) => string | null;
  recordProxiedConnectFailure?: (proxyUrl: string, error?: unknown) => void;
  recordProxiedConnectSuccess?: (proxyUrl: string) => void;
  rethrowIfNetworkProxyUnavailable?: (error: unknown) => void;
  runWithEgressScope: <T>(scope: EgressScopeId, fn: () => Promise<T>) => Promise<T>;
  /**
   * Sync ALS enter. Returns `fn()`'s value as-is so MarketService sync
   * methods (`getSDK`, `getSkillDownloadUrl`) stay synchronous.
   */
  runWithEgressScopeSync?: <T>(scope: EgressScopeId, fn: () => T) => T;
  wrapRuntimeWithEgressScope: <T extends object>(runtime: T, scope: EgressScopeId) => T;
}

type GlobalWithBinding = typeof globalThis & {
  [NETWORK_PROXY_EGRESS_BINDING]?: NetworkProxyEgressBinding;
};

export const getEgressBinding = (): NetworkProxyEgressBinding | undefined =>
  (globalThis as GlobalWithBinding)[NETWORK_PROXY_EGRESS_BINDING];

export const setEgressBinding = (binding: NetworkProxyEgressBinding): void => {
  (globalThis as GlobalWithBinding)[NETWORK_PROXY_EGRESS_BINDING] = binding;
};

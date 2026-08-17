import debug from 'debug';

import type { EgressScopeId, NetworkProxyOutletKind } from '@/const/platform/networkProxy';
import { NETWORK_PROXY_LIMITS, parseEgressScopeId } from '@/const/platform/networkProxy';
import type { EgressScopeState, OutletStatusView } from '@/types/platform/networkProxy';

import { isAlwaysDirectTarget } from './bypass';
import { isCircuitOpen } from './circuit';
import {
  consumeFallbackFirstWarn,
  getEgressCounters,
  incrementFallback,
  incrementProxied,
} from './counters';
import type { EgressEngineStateView, EgressSnapshotView } from './deps';
import { getEngineState, getSnapshot, isLegacyGlobalProxyActive, peekSnapshot } from './deps';
import { NetworkProxyUnavailableError } from './error';
import { getStaticOutletHealth, startStaticOutletHealthLoop } from './staticHealth';

const log = debug('lobe-server:network-proxy:egress');

export type EgressDecision =
  | {
      mode: 'direct';
      reason: 'bypass' | 'fallback' | 'global_proxy_active' | 'master_off' | 'scope_off';
    }
  | { mode: 'fail'; error: 'PLATFORM_NETWORK_PROXY_UNAVAILABLE' }
  | { mode: 'proxy'; outlet: NetworkProxyOutletKind; proxyUrl: string };

const toUrl = (target: URL | string): URL | null => {
  if (target instanceof URL) return target;
  try {
    return new URL(target);
  } catch {
    return null;
  }
};

const resolveScopeState = (
  config: EgressSnapshotView['config'],
  scope: EgressScopeId,
): EgressScopeState | null => {
  const parsed = parseEgressScopeId(scope);
  if (!parsed) return null;
  if (parsed.kind === 'provider') {
    return config.scopes.providers[parsed.id] ?? null;
  }
  return config.scopes.features[parsed.id] ?? { enabled: false, onUnavailable: 'direct' };
};

const engineOutletAvailable = (engine: EgressEngineStateView): string | null => {
  if (engine.state !== 'running') return null;
  if (!engine.proxyUrl) return null;
  if (!engine.aliveNodeCount || engine.aliveNodeCount <= 0) return null;
  return engine.proxyUrl;
};

const staticOutletAvailable = (snapshot: EgressSnapshotView): string | null => {
  if (!snapshot.staticProxyUrl) return null;
  const health = getStaticOutletHealth();
  if (!health.ok) return null;
  return snapshot.staticProxyUrl;
};

const decideOutlet = (
  snapshot: EgressSnapshotView,
  engine: EgressEngineStateView,
): {
  available: boolean;
  outlet: NetworkProxyOutletKind;
  proxyUrl: string | null;
  reason: string | null;
} => {
  const kind = snapshot.config.outlet.kind;
  if (isCircuitOpen(kind)) {
    return { available: false, outlet: kind, proxyUrl: null, reason: 'circuit_open' };
  }
  if (kind === 'engine') {
    const proxyUrl = engineOutletAvailable(engine);
    if (!proxyUrl) {
      return {
        available: false,
        outlet: kind,
        proxyUrl: null,
        reason: engine.state === 'running' ? 'no_alive_nodes' : `engine_${engine.state}`,
      };
    }
    return { available: true, outlet: kind, proxyUrl, reason: null };
  }
  const proxyUrl = staticOutletAvailable(snapshot);
  if (!proxyUrl) {
    return { available: false, outlet: kind, proxyUrl: null, reason: 'static_probe_failed' };
  }
  return { available: true, outlet: kind, proxyUrl, reason: null };
};

const decide = (
  snapshot: EgressSnapshotView,
  engine: EgressEngineStateView,
  scope: EgressScopeId,
  target: URL,
): EgressDecision => {
  if (!snapshot.config.masterEnabled) {
    return { mode: 'direct', reason: 'master_off' };
  }
  if (isLegacyGlobalProxyActive()) {
    return { mode: 'direct', reason: 'global_proxy_active' };
  }
  if (isAlwaysDirectTarget(target, snapshot.config.bypassHosts)) {
    return { mode: 'direct', reason: 'bypass' };
  }

  const scopeState = resolveScopeState(snapshot.config, scope);
  if (!scopeState?.enabled) {
    return { mode: 'direct', reason: 'scope_off' };
  }

  const outlet = decideOutlet(snapshot, engine);
  if (outlet.available && outlet.proxyUrl) {
    incrementProxied(scope);
    return { mode: 'proxy', outlet: outlet.outlet, proxyUrl: outlet.proxyUrl };
  }

  if (scopeState.onUnavailable === 'fail') {
    return { error: 'PLATFORM_NETWORK_PROXY_UNAVAILABLE', mode: 'fail' };
  }

  incrementFallback(scope);
  if (consumeFallbackFirstWarn(scope)) {
    log(
      'warn outlet unavailable for %s (%s); falling back to direct',
      scope,
      outlet.reason ?? 'unknown',
    );
  }
  return { mode: 'direct', reason: 'fallback' };
};

/**
 * Async hot path: always go through B1's TTL / invalidation-aware cache.
 * Do not use `peek ?? get` — a process-local peek would skip the 60 s reload.
 */
export const resolveEgress = async (
  scope: EgressScopeId,
  target: URL | string,
): Promise<EgressDecision> => {
  startStaticOutletHealthLoop();
  const url = toUrl(target);
  if (!url) return { mode: 'direct', reason: 'bypass' };
  const snapshot = await getSnapshot();
  return decide(snapshot, getEngineState(), scope, url);
};

/**
 * Sync path for the ssrf-safe-fetch binding. Uses peek only.
 * - No snapshot yet → `direct(master_off)` and kick a background load.
 * - Peeked snapshot older than SETTINGS_SNAPSHOT_TTL_MS → kick a background refresh.
 */
export const resolveEgressSync = (scope: EgressScopeId, target: URL | string): EgressDecision => {
  const url = toUrl(target);
  if (!url) return { mode: 'direct', reason: 'bypass' };
  const snapshot = peekSnapshot();
  if (!snapshot) {
    void getSnapshot();
    return { mode: 'direct', reason: 'master_off' };
  }
  if (Date.now() - snapshot.loadedAt > NETWORK_PROXY_LIMITS.SETTINGS_SNAPSHOT_TTL_MS) {
    void getSnapshot();
  }
  return decide(snapshot, getEngineState(), scope, url);
};

/**
 * Curl transport helper. Returns the proxy URL, `null` for any *direct*
 * decision, and throws `NetworkProxyUnavailableError` on `fail`.
 */
export const getEgressProxyUrlForCurl = async (
  scope: EgressScopeId,
  target: string,
): Promise<string | null> => {
  const decision = await resolveEgress(scope, target);
  if (decision.mode === 'fail') throw new NetworkProxyUnavailableError();
  return decision.mode === 'proxy' ? decision.proxyUrl : null;
};

export const buildEgressEnv = (
  decision: EgressDecision,
  bypassHosts: string[],
): Record<string, string> => {
  if (decision.mode !== 'proxy') return {};
  const noProxy = ['localhost', '127.0.0.1', '::1', ...bypassHosts].join(',');
  return {
    ALL_PROXY: decision.proxyUrl,
    HTTP_PROXY: decision.proxyUrl,
    HTTPS_PROXY: decision.proxyUrl,
    NO_PROXY: noProxy,
  };
};

export const getOutletHealth = (): OutletStatusView => {
  startStaticOutletHealthLoop();
  const snapshot = peekSnapshot();
  const engine = getEngineState();
  const kind = snapshot?.config.outlet.kind ?? 'engine';
  const circuitOpen = isCircuitOpen(kind);
  const outlet = snapshot
    ? decideOutlet(snapshot, engine)
    : { available: false, outlet: kind, proxyUrl: null, reason: 'no_snapshot' };

  return {
    activeNode: kind === 'engine' ? engine.activeNode : null,
    activeNodeDelayMs: null,
    available: Boolean(snapshot?.config.masterEnabled) && outlet.available && !circuitOpen,
    circuitOpen,
    kind,
    unavailableReason: !snapshot?.config.masterEnabled
      ? 'master_off'
      : circuitOpen
        ? 'circuit_open'
        : (outlet.reason ?? null),
  };
};

export { getEgressCounters };
export { isAlwaysDirectTarget } from './bypass';
export { recordConnectPhaseFailure } from './circuit';

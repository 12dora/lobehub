import type { NetworkProxyOutletKind } from '@/const/platform/networkProxy';
import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';

/**
 * Connect-phase circuit breaker (design §3.5 / §3.6), **per outlet kind**.
 *
 * Counted: ECONNREFUSED / ETIMEDOUT / EHOSTUNREACH to the *proxy* host,
 * 407, UND_ERR_CONNECT_TIMEOUT before headers, TLS-to-proxy failure.
 *
 * Not counted: target-side CERT_HAS_EXPIRED, ENOTFOUND for the target host,
 * UND_ERR_SOCKET after response headers.
 *
 * A successful proxied response or static probe resets that outlet's breaker.
 */
interface OutletCircuit {
  failureAt: number[];
  openedAt: number | null;
}

const circuits = new Map<NetworkProxyOutletKind, OutletCircuit>();

const now = () => Date.now();

const stateOf = (outlet: NetworkProxyOutletKind): OutletCircuit => {
  let state = circuits.get(outlet);
  if (!state) {
    state = { failureAt: [], openedAt: null };
    circuits.set(outlet, state);
  }
  return state;
};

const prune = (state: OutletCircuit, at: number) => {
  const cutoff = at - NETWORK_PROXY_LIMITS.CIRCUIT_WINDOW_MS;
  while (state.failureAt.length > 0 && state.failureAt[0]! < cutoff) {
    state.failureAt.shift();
  }
};

export const recordConnectPhaseFailure = (outlet: NetworkProxyOutletKind): void => {
  const state = stateOf(outlet);
  const at = now();
  prune(state, at);
  state.failureAt.push(at);
  if (state.failureAt.length >= NETWORK_PROXY_LIMITS.CIRCUIT_FAILURE_THRESHOLD) {
    state.openedAt = at;
  }
};

export const recordConnectPhaseSuccess = (outlet: NetworkProxyOutletKind): void => {
  const state = stateOf(outlet);
  state.failureAt.length = 0;
  state.openedAt = null;
};

export const isCircuitOpen = (outlet?: NetworkProxyOutletKind): boolean => {
  if (!outlet) return isCircuitOpen('engine') || isCircuitOpen('static');
  const state = stateOf(outlet);
  if (state.openedAt === null) return false;
  if (now() - state.openedAt >= NETWORK_PROXY_LIMITS.CIRCUIT_OPEN_MS) {
    state.openedAt = null;
    state.failureAt.length = 0;
    return false;
  }
  return true;
};

export const resetCircuitForTest = (): void => {
  circuits.clear();
};

export type { ConnectPhaseContext } from './connectPhaseFailure';
export { isConnectPhaseFailure } from './connectPhaseFailure';

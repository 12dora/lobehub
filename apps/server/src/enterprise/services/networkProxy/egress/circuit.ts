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

const hostOf = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return value.replaceAll(/^\[|\]$/g, '').toLowerCase() || null;
  }
};

const failedHostOf = (error: {
  address?: string;
  cause?: { address?: string; hostname?: string };
  hostname?: string;
  message?: string;
}): string | null => {
  const raw = error.hostname ?? error.cause?.hostname ?? error.address ?? error.cause?.address;
  if (raw) return hostOf(typeof raw === 'string' ? `http://${raw}` : undefined) ?? String(raw);
  const match = /(?:getaddrinfo\s+\w+\s+|connect\s+\w+\s+)([\w.:-]+)/i.exec(error.message ?? '');
  return match?.[1]?.toLowerCase() ?? null;
};

export interface ConnectPhaseContext {
  /** True when the failure happened before response headers. Default true. */
  beforeHeaders?: boolean;
  /** Proxy URL in use; used to tell proxy-host failures from target-host failures. */
  proxyUrl?: string;
}

/**
 * True only for *proxy-connect-stage* failures. Target-side TLS / DNS / post-header
 * socket errors must not open the outlet breaker.
 */
export const isConnectPhaseFailure = (error: unknown, ctx: ConnectPhaseContext = {}): boolean => {
  if (!error || typeof error !== 'object') return false;
  const err = error as {
    address?: string;
    cause?: { address?: string; code?: string; hostname?: string; message?: string };
    code?: string;
    errno?: string;
    hostname?: string;
    message?: string;
    statusCode?: number;
  };
  const code = err.code ?? err.errno ?? err.cause?.code ?? '';
  const message = `${err.message ?? ''} ${err.cause?.message ?? ''}`.toLowerCase();
  const beforeHeaders = ctx.beforeHeaders !== false;
  const proxyHost = hostOf(ctx.proxyUrl);
  const failedHost = failedHostOf(err);

  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return false;
  }
  if (code === 'UND_ERR_SOCKET' && !beforeHeaders) {
    return false;
  }
  if (
    err.statusCode === 407 ||
    message.includes('407') ||
    message.includes('proxy authentication')
  ) {
    return true;
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' && beforeHeaders) {
    return true;
  }
  if (
    (code === 'UND_ERR_TLS' || message.includes('tls')) &&
    beforeHeaders &&
    (message.includes('proxy') || (proxyHost && failedHost === proxyHost))
  ) {
    return true;
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH'
  ) {
    if (proxyHost && failedHost) return failedHost === proxyHost;
    return beforeHeaders;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return Boolean(proxyHost && failedHost && failedHost === proxyHost);
  }
  if (message.includes('proxy') && (message.includes('timeout') || message.includes('handshake'))) {
    return true;
  }
  return false;
};

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  AgentRuntimeError,
  runWithBoundFetch,
  runWithBoundFetchSync,
} from '@lobechat/model-runtime';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { EgressScopeId, NetworkProxyOutletKind } from '@/const/platform/networkProxy';

import {
  isConnectPhaseFailure,
  recordConnectPhaseFailure,
  recordConnectPhaseSuccess,
} from './circuit';
import { getEngineState, peekSnapshot } from './deps';
import { closeDispatchersExcept } from './dispatchers';
import {
  isNetworkProxyUnavailableError,
  NetworkProxyUnavailableError,
  rethrowIfNetworkProxyUnavailable,
} from './error';
import { createEgressFetch } from './fetch';
import { setEgressBinding } from './hook';
import { resolveEgressSync } from './router';
import { createEgressSafeOutboundTransport } from './safeOutboundTransport';

const scopeAls = new AsyncLocalStorage<EgressScopeId>();

export const getCurrentEgressScope = (): EgressScopeId | null => scopeAls.getStore() ?? null;

const toRuntimeUnavailable = (scope: EgressScopeId, error: unknown) => {
  const provider = scope.startsWith('provider:') ? scope.slice('provider:'.length) : 'unknown';
  throw AgentRuntimeError.chat({
    error: error instanceof Error ? { message: error.message, name: error.name } : { error },
    errorType: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNAVAILABLE as never,
    provider,
  });
};

/**
 * Bind `createEgressFetch(scope)` as the ALS global fetch for `fn`.
 * Also records the current scope so `ssrfSafeFetch` can pick a proxy agent
 * via the global-symbol registry.
 */
export const runWithEgressScope = async <T>(
  scope: EgressScopeId,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await scopeAls.run(scope, () => runWithBoundFetch(createEgressFetch(scope), fn));
  } catch (error) {
    if (isNetworkProxyUnavailableError(error)) toRuntimeUnavailable(scope, error);
    throw error;
  }
};

/**
 * Synchronous ALS enter for MarketService / bindFeatureEgressScope.
 * Returns `fn()`'s value as-is so sync methods stay sync.
 */
export const runWithEgressScopeSync = <T>(scope: EgressScopeId, fn: () => T): T => {
  try {
    return scopeAls.run(scope, () => runWithBoundFetchSync(createEgressFetch(scope), fn));
  } catch (error) {
    if (isNetworkProxyUnavailableError(error)) toRuntimeUnavailable(scope, error);
    throw error;
  }
};

/**
 * JS Proxy: every function property on `runtime` is invoked inside
 * `runWithEgressScope`. Non-functions are returned as-is. `this` is preserved
 * (the original target when called through the proxy).
 *
 * `NetworkProxyUnavailableError` is converted to the AgentRuntimeError shape
 * so chat routes map it to HTTP 503 (not a provider 471).
 */
export const wrapRuntimeWithEgressScope = <T extends object>(runtime: T, scope: EgressScopeId): T =>
  new Proxy(runtime, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return function (this: unknown, ...args: unknown[]) {
        const self = this === receiver ? target : this;
        return runWithEgressScope(scope, async () =>
          Reflect.apply(value as (...inner: unknown[]) => unknown, self, args),
        );
      };
    },
  });

/**
 * Sync binding for ssrf-safe-fetch. Throws on `fail` so the OSS package can
 * rethrow PLATFORM_NETWORK_PROXY_UNAVAILABLE instead of going direct.
 */
const getProxyUrlFor = (url: string): string | null => {
  const scope = getCurrentEgressScope();
  if (!scope) return null;
  const decision = resolveEgressSync(scope, url);
  if (decision.mode === 'fail') throw new NetworkProxyUnavailableError();
  return decision.mode === 'proxy' ? decision.proxyUrl : null;
};

const getEgressProxyUrlForCurl = async (
  scope: EgressScopeId,
  target: string,
): Promise<string | null> => {
  const { getEgressProxyUrlForCurl: impl } = await import('./router');
  return impl(scope, target);
};

const outletOfProxyUrl = (proxyUrl: string): NetworkProxyOutletKind => {
  const engineUrl = getEngineState().proxyUrl;
  if (engineUrl && engineUrl === proxyUrl) return 'engine';
  return 'static';
};

const keepActiveProxyUrls = (): Set<string> => {
  const keep = new Set<string>();
  const snap = peekSnapshot();
  if (snap?.staticProxyUrl) keep.add(snap.staticProxyUrl);
  const engineUrl = getEngineState().proxyUrl;
  if (engineUrl) keep.add(engineUrl);
  return keep;
};

const syncCaches = () => {
  const keep = keepActiveProxyUrls();
  closeDispatchersExcept(keep);
  void import('../../chatgptWeb/transport/curlImpersonateFetch').then(({ evictChatGPTWebFetchExcept }) => {
    evictChatGPTWebFetchExcept(keep);
  });
  void import('../../cursorAgent').then(({ evictCursorAgentFetchExcept }) => {
    evictCursorAgentFetchExcept(keep);
  });
};

let cacheInvalidationBound = false;

/**
 * Subscribe to snapshot / engine changes so dispatcher + curl caches evict.
 * Must run *after* both `scope` and `snapshot` have finished evaluating —
 * calling `onNetworkProxySnapshotChange` at module-eval time races a cycle
 * (`scope` → `snapshot` → … → `scope`) and throws
 * `onNetworkProxySnapshotChange is not a function`.
 */
export const bindEgressCacheInvalidation = (): void => {
  if (cacheInvalidationBound) return;
  cacheInvalidationBound = true;
  void import('../snapshot').then(({ onNetworkProxySnapshotChange }) => {
    onNetworkProxySnapshotChange(() => {
      syncCaches();
    });
  });
  void import('../engine/runtime')
    .then(({ getEngineRuntime }) => {
      getEngineRuntime().onStateChange(() => {
        syncCaches();
      });
    })
    .catch(() => {
      // Engine runtime may be unavailable in isolated unit tests.
    });
};

/** Test helper. */
export const resetEgressCacheInvalidationForTest = (): void => {
  cacheInvalidationBound = false;
};

setEgressBinding({
  createEgressFetch,
  createEgressSafeOutboundTransport,
  getCurrentScope: getCurrentEgressScope,
  getEgressProxyUrlForCurl,
  getProxyUrlFor,
  recordProxiedConnectFailure: (proxyUrl, error) => {
    if (error && !isConnectPhaseFailure(error, { beforeHeaders: true, proxyUrl })) return;
    recordConnectPhaseFailure(outletOfProxyUrl(proxyUrl));
  },
  recordProxiedConnectSuccess: (proxyUrl) => {
    recordConnectPhaseSuccess(outletOfProxyUrl(proxyUrl));
  },
  rethrowIfNetworkProxyUnavailable,
  runWithEgressScope,
  runWithEgressScopeSync,
  wrapRuntimeWithEgressScope,
});

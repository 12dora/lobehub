import { fetch as undiciFetch } from 'undici';

import type { EgressScopeId } from '@/const/platform/networkProxy';

import {
  isConnectPhaseFailure,
  recordConnectPhaseFailure,
  recordConnectPhaseSuccess,
} from './circuit';
import { getDispatcher } from './dispatchers';
import { NetworkProxyUnavailableError } from './error';
import type { EgressDecision } from './router';
import { resolveEgress } from './router';

const ORIGINAL_FETCH_KEY = Symbol.for('lobe.model-runtime.boundFetch.original');

const extractUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
};

const originalFetch = (): typeof fetch => {
  const bound = (globalThis as typeof globalThis & { [ORIGINAL_FETCH_KEY]?: typeof fetch })[
    ORIGINAL_FETCH_KEY
  ];
  return bound ?? globalThis.fetch.bind(globalThis);
};

const dispatchProxied = async (
  decision: Extract<EgressDecision, { mode: 'proxy' }>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const dispatcher = getDispatcher(decision.proxyUrl);
  try {
    const response = (await undiciFetch(
      input as never,
      Object.assign({}, init ?? {}, { dispatcher }) as never,
    )) as unknown as Response;
    if (response.status === 407) {
      recordConnectPhaseFailure(decision.outlet);
    } else {
      recordConnectPhaseSuccess(decision.outlet);
    }
    return response;
  } catch (error) {
    if (isConnectPhaseFailure(error, { beforeHeaders: true, proxyUrl: decision.proxyUrl })) {
      recordConnectPhaseFailure(decision.outlet);
    }
    throw error;
  }
};

/**
 * Per-call fetch bound to an egress scope. The request URL is inspected on
 * every invocation — the decision is never frozen at construction time.
 */
export const createEgressFetch = (scope: EgressScopeId): typeof fetch => {
  const egressFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const decision = await resolveEgress(scope, extractUrl(input));
    if (decision.mode === 'fail') {
      throw new NetworkProxyUnavailableError();
    }
    if (decision.mode === 'direct') {
      return originalFetch()(input, init);
    }
    return dispatchProxied(decision, input, init);
  }) as typeof fetch;

  return egressFetch;
};

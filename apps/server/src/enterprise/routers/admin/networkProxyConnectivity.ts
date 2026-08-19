import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';

import type { NetworkProxyRuntime } from './networkProxyRuntime';

const createInlineDispatcher = (proxyUrl: string): ProxyAgent => new ProxyAgent({ uri: proxyUrl });

export const testOutletConnectivity = async (
  runtime: NetworkProxyRuntime,
  latencyTestUrl: string,
): Promise<{
  egressIp: string | null;
  error: string | null;
  latencyMs: number | null;
  ok: boolean;
}> => {
  const settingsKind = (await Promise.resolve(runtime.getOutletHealth())).kind;
  const engineState = runtime.getEngineRuntime().getState();
  const snapshot = runtime.peekNetworkProxySnapshot();
  const proxyUrl =
    settingsKind === 'static' ? (snapshot?.staticProxyUrl ?? null) : engineState.proxyUrl;

  if (!proxyUrl) {
    return { egressIp: null, error: 'outlet_unavailable', latencyMs: null, ok: false };
  }

  const dispatcher = runtime.getDispatcherFor?.(proxyUrl) ?? createInlineDispatcher(proxyUrl);
  const startedAt = Date.now();
  try {
    const response = await undiciFetch(latencyTestUrl, {
      dispatcher: dispatcher as never,
      method: 'GET',
      signal: AbortSignal.timeout(NETWORK_PROXY_LIMITS.LATENCY_TEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    let egressIp: string | null = null;
    try {
      const ipResponse = await undiciFetch('https://api.ip.sb/ip', {
        dispatcher: dispatcher as never,
        method: 'GET',
        signal: AbortSignal.timeout(NETWORK_PROXY_LIMITS.LATENCY_TEST_TIMEOUT_MS),
      });
      if (ipResponse.ok) {
        const text = (await ipResponse.text()).trim();
        egressIp = text.length > 0 && text.length <= 64 ? text : null;
      }
    } catch {
      egressIp = null;
    }
    return {
      egressIp,
      error: response.ok ? null : runtime.redactSecrets(`http_${response.status}`),
      latencyMs,
      ok: response.ok,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'outlet_request_failed';
    return {
      egressIp: null,
      error: runtime.redactSecrets(message),
      latencyMs: Date.now() - startedAt,
      ok: false,
    };
  }
};

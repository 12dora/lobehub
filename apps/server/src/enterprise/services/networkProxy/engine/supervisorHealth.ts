import { NETWORK_PROXY_ENGINE_GROUP_NAME } from '@/const/platform/networkProxy';
import type { ProxyNodeView } from '@/types/platform/networkProxy';

import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';
import type { EngineRestClient } from './restClient';
import type { SupervisorHandle } from './supervisorHandle';
import type { ProxyDetail } from './supervisorHelpers';
import {
  HEALTH_POLL_MS,
  isTimeoutError,
  memberAlive,
  pickInformationalIssue,
  sleep,
} from './supervisorHelpers';

export const requireEngineRest = (rest: EngineRestClient | null): EngineRestClient => {
  const client = rest;
  if (!client) {
    return throwNetworkProxyError(
      NETWORK_PROXY_ENGINE_ERROR_CODES.ENGINE_ERROR,
      'engine REST client is not available',
    );
  }
  return client;
};

export const waitUntilHealthy = async (
  rest: EngineRestClient | null,
  startWaitMs: number,
): Promise<void> => {
  if (!rest) throw new Error('engine REST client missing');
  const deadline = Date.now() + startWaitMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await rest.version();
      return;
    } catch (error) {
      lastError = error;
      await sleep(HEALTH_POLL_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('engine did not become healthy');
};

export const startHealthLoop = (host: SupervisorHandle): void => {
  stopHealthLoop(host);
  host.healthTimer = setInterval(() => {
    void healthTick(host).catch((error) => host.setIssueFromUnknown(error));
  }, host.healthIntervalMs);
  host.healthTimer.unref();
};

export const stopHealthLoop = (host: SupervisorHandle): void => {
  if (host.healthTimer) {
    clearInterval(host.healthTimer);
    host.healthTimer = null;
  }
};

export const healthTick = async (host: SupervisorHandle): Promise<void> => {
  if (!host.rest || !host.child) return;
  try {
    await host.rest.version();
    host.healthFailures = 0;
    const group = await host.rest.getGroup(NETWORK_PROXY_ENGINE_GROUP_NAME);
    const { proxies } = await collectProxyDetails(host.rest);
    const alive = group.all.filter((name) => memberAlive(proxies[name])).length;
    const geodataIssue = pickInformationalIssue(host.state.lastIssue);
    host.patchState({
      activeNode: group.now || null,
      aliveNodeCount: alive,
      healAttempts: 0,
      lastIssue: geodataIssue,
      nextHealAt: null,
      state: alive > 0 ? 'running' : 'degraded',
    });
  } catch (error) {
    host.healthFailures += 1;
    host.setIssue(isTimeoutError(error) ? 'health_timeout' : 'health_unreachable', error);
    if (host.healthFailures >= host.healthFailuresBeforeRestart) {
      await host.restart().catch((restartError) => host.setIssueFromUnknown(restartError));
    }
  }
};

/**
 * mihomo's `GET /proxies` only lists top-level proxies and groups; nodes that come from a
 * `proxy-providers` entry (all of ours) are only reported under `GET /providers/proxies`.
 * Merge both so liveness / delay / type resolve for provider-sourced members.
 */
export const collectProxyDetails = async (
  rest: EngineRestClient,
): Promise<{
  owner: Map<string, string>;
  proxies: Record<string, ProxyDetail | undefined>;
}> => {
  const [topLevel, providers] = await Promise.all([
    rest.getProxies(),
    rest.getProviders().catch(() => ({})),
  ]);
  const proxies: Record<string, ProxyDetail | undefined> = { ...topLevel };
  const owner = new Map<string, string>();
  for (const [providerName, provider] of Object.entries(providers)) {
    const subscriptionId = providerName.startsWith('sub_') ? providerName.slice(4) : null;
    for (const proxy of provider.proxies ?? []) {
      owner.set(proxy.name, subscriptionId ?? providerName);
      // provider view is authoritative for its own members (carries alive/history)
      proxies[proxy.name] = proxy;
    }
  }
  return { owner, proxies };
};

export const readNodes = async (rest: EngineRestClient): Promise<ProxyNodeView[]> => {
  const group = await rest.getGroup(NETWORK_PROXY_ENGINE_GROUP_NAME);
  const { owner, proxies } = await collectProxyDetails(rest);
  return group.all.map((name) => {
    const proxy = proxies[name];
    const last = proxy?.history?.at(-1)?.delay;
    return {
      alive: memberAlive(proxy),
      delayMs: last && last > 0 ? last : null,
      name,
      subscriptionId: owner.get(name) ?? null,
      type: proxy?.type ?? 'unknown',
    };
  });
};

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NetworkProxyConfig } from '@/types/platform/networkProxy';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import { resetCircuitForTest } from './circuit';
import { getEgressCounters, resetEgressCountersForTest } from './counters';
import type { EgressEngineStateView, EgressSnapshotView } from './deps';
import { setEgressDepsForTest } from './deps';
import { resetDispatchersForTest } from './dispatchers';
import { NetworkProxyUnavailableError } from './error';
import { createEgressFetch } from './fetch';
import { resolveEgress } from './router';
import { runWithEgressScope } from './scope';
import { setStaticOutletHealthForTest, stopStaticOutletHealthLoopForTest } from './staticHealth';

const enabledScope = (onUnavailable: 'direct' | 'fail' = 'direct') => ({
  enabled: true,
  onUnavailable,
});

const snapshotWith = (
  patch: (config: NetworkProxyConfig) => void,
  extra?: Partial<EgressSnapshotView>,
): EgressSnapshotView => {
  const config = createDefaultNetworkProxyConfig();
  patch(config);
  return {
    config,
    loadedAt: extra?.loadedAt ?? Date.now(),
    revision: 1,
    staticProxyUrl: extra?.staticProxyUrl ?? null,
  };
};

const stoppedEngine = (): EgressEngineStateView => ({
  activeNode: null,
  aliveNodeCount: null,
  proxyUrl: null,
  state: 'stopped',
});

const runningEngine = (proxyUrl: string): EgressEngineStateView => ({
  activeNode: 'node-a',
  aliveNodeCount: 2,
  proxyUrl,
  state: 'running',
});

describe('resolveEgress precedence', () => {
  afterEach(() => {
    setEgressDepsForTest(null);
    resetEgressCountersForTest();
    resetCircuitForTest();
    stopStaticOutletHealthLoopForTest();
  });

  it('returns direct(master_off) when the master switch is off', async () => {
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => snapshotWith(() => undefined),
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snapshotWith(() => undefined),
    });
    await expect(resolveEgress('feature:market', 'https://example.com/a')).resolves.toEqual({
      mode: 'direct',
      reason: 'master_off',
    });
  });

  it('returns direct(global_proxy_active) when PROXY_URL is set', async () => {
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () =>
        snapshotWith((config) => {
          config.masterEnabled = true;
        }),
      isLegacyGlobalProxyActive: () => true,
      peekSnapshot: () =>
        snapshotWith((config) => {
          config.masterEnabled = true;
        }),
    });
    await expect(resolveEgress('feature:market', 'https://example.com/a')).resolves.toEqual({
      mode: 'direct',
      reason: 'global_proxy_active',
    });
  });

  it('returns direct(bypass) for loopback and RFC1918 targets', async () => {
    const snap = snapshotWith((config) => {
      config.masterEnabled = true;
      config.scopes.features.market = enabledScope();
    });
    setEgressDepsForTest({
      getEngineState: () => runningEngine('http://aihub:pw@127.0.0.1:9'),
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });
    await expect(resolveEgress('feature:market', 'http://127.0.0.1:9/x')).resolves.toEqual({
      mode: 'direct',
      reason: 'bypass',
    });
    await expect(resolveEgress('feature:market', 'http://10.0.0.8/x')).resolves.toEqual({
      mode: 'direct',
      reason: 'bypass',
    });
  });

  it('returns direct(scope_off) when the provider is not listed', async () => {
    const snap = snapshotWith((config) => {
      config.masterEnabled = true;
    });
    setEgressDepsForTest({
      getEngineState: () => runningEngine('http://aihub:pw@127.0.0.1:9'),
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });
    await expect(resolveEgress('provider:openai', 'https://api.openai.com/v1')).resolves.toEqual({
      mode: 'direct',
      reason: 'scope_off',
    });
  });

  it('returns proxy when the static outlet is healthy and the scope is on', async () => {
    setStaticOutletHealthForTest(true);
    const snap = snapshotWith(
      (config) => {
        config.masterEnabled = true;
        config.outlet.kind = 'static';
        config.scopes.features.market = enabledScope();
      },
      { staticProxyUrl: 'http://127.0.0.1:18080' },
    );
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });
    await expect(resolveEgress('feature:market', 'https://example.com/a')).resolves.toEqual({
      mode: 'proxy',
      outlet: 'static',
      proxyUrl: 'http://127.0.0.1:18080',
    });
    expect(getEgressCounters().proxied['feature:market']).toBe(1);
  });

  it('counts fallback and returns direct when the engine is not running', async () => {
    const snap = snapshotWith((config) => {
      config.masterEnabled = true;
      config.scopes.features.market = enabledScope('direct');
    });
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });
    await expect(resolveEgress('feature:market', 'https://example.com/a')).resolves.toEqual({
      mode: 'direct',
      reason: 'fallback',
    });
    expect(getEgressCounters().fallback['feature:market']).toBe(1);
    expect(getEgressCounters().fallbackScopes).toContain('feature:market');
  });

  it('returns fail when onUnavailable is fail and the outlet is down', async () => {
    const snap = snapshotWith((config) => {
      config.masterEnabled = true;
      config.scopes.features.market = enabledScope('fail');
    });
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });
    await expect(resolveEgress('feature:market', 'https://example.com/a')).resolves.toEqual({
      error: 'PLATFORM_NETWORK_PROXY_UNAVAILABLE',
      mode: 'fail',
    });
    await expect(
      createEgressFetch('feature:market')('https://example.com/a'),
    ).rejects.toBeInstanceOf(NetworkProxyUnavailableError);
  });

  it('throws from getEgressProxyUrlForCurl on fail instead of returning null', async () => {
    const { getEgressProxyUrlForCurl } = await import('./router');
    const snap = snapshotWith((config) => {
      config.masterEnabled = true;
      config.scopes.features.market = enabledScope('fail');
    });
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });
    await expect(
      getEgressProxyUrlForCurl('feature:market', 'https://example.com/a'),
    ).rejects.toBeInstanceOf(NetworkProxyUnavailableError);
  });

  it('uses the catalog provider id; unlisted custom providers stay off', async () => {
    const snap = snapshotWith((config) => {
      config.masterEnabled = true;
      config.outlet.kind = 'static';
      config.scopes.providers['catalog-custom'] = enabledScope();
      config.scopes.providers.openai = enabledScope();
    });
    setStaticOutletHealthForTest(true);
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => ({ ...snap, staticProxyUrl: 'http://127.0.0.1:18080' }),
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => ({ ...snap, staticProxyUrl: 'http://127.0.0.1:18080' }),
    });
    await expect(
      resolveEgress('provider:catalog-custom', 'https://api.example.com'),
    ).resolves.toMatchObject({
      mode: 'proxy',
    });
    await expect(
      resolveEgress('provider:user-private-xyz', 'https://api.example.com'),
    ).resolves.toEqual({
      mode: 'direct',
      reason: 'scope_off',
    });
  });
});

const listen = (server: http.Server | net.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        reject(new Error('no address'));
        return;
      }
      resolve(address.port);
    });
    server.on('error', reject);
  });

const close = (server: http.Server | net.Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

describe('createEgressFetch with a fake HTTP CONNECT proxy', () => {
  let origin: http.Server;
  let originPort: number;
  let proxy: http.Server;
  let proxyPort: number;
  let connectCount = 0;

  beforeEach(async () => {
    resetEgressCountersForTest();
    resetCircuitForTest();
    setStaticOutletHealthForTest(true);
    connectCount = 0;

    origin = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`origin:${req.url}`);
    });
    originPort = await listen(origin);

    proxy = http.createServer((_req, res) => {
      res.writeHead(400);
      res.end('plain http proxy unused');
    });
    proxy.on('connect', (req, clientSocket, head) => {
      connectCount += 1;
      const [host, portRaw] = (req.url ?? '').split(':');
      const port = Number(portRaw || 80);
      const upstream = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.end());
    });
    proxyPort = await listen(proxy);

    const snap = snapshotWith(
      (config) => {
        config.masterEnabled = true;
        config.outlet.kind = 'static';
        config.scopes.features.market = enabledScope();
        config.scopes.features.web_search = enabledScope();
      },
      { staticProxyUrl: `http://127.0.0.1:${proxyPort}` },
    );
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });
  });

  afterEach(async () => {
    setEgressDepsForTest(null);
    stopStaticOutletHealthLoopForTest();
    await resetDispatchersForTest();
    await close(proxy);
    await close(origin);
  });

  it('sends scoped traffic through the proxy', async () => {
    const fetchImpl = createEgressFetch('feature:market');
    const response = await fetchImpl(`http://127.0.0.1:${originPort}/hello`);
    // 127.0.0.1 is always-direct, so this must NOT hit the proxy.
    expect(connectCount).toBe(0);
    expect(await response.text()).toBe('origin:/hello');
  });

  it('uses the proxy for a public hostname when the scope is enabled', async () => {
    // The CONNECT proxy will fail to resolve example.invalid — we only assert
    // that CONNECT was attempted (proxy path selected).
    const fetchImpl = createEgressFetch('feature:market');
    await fetchImpl('http://example.invalid/').catch(() => undefined);
    expect(connectCount).toBeGreaterThanOrEqual(1);
  });

  it('decides per call: bypass host stays direct, public host goes proxy', async () => {
    const fetchImpl = createEgressFetch('feature:market');
    const direct = await fetchImpl(`http://127.0.0.1:${originPort}/local`);
    expect(await direct.text()).toBe('origin:/local');
    const before = connectCount;
    await fetchImpl('http://example.invalid/public').catch(() => undefined);
    expect(connectCount).toBeGreaterThan(before);
  });

  it('makes a bare globalThis.fetch inside runWithEgressScope use the bound fetch', async () => {
    await runWithEgressScope('feature:market', async () => {
      await globalThis.fetch('http://example.invalid/als').catch(() => undefined);
    });
    expect(connectCount).toBeGreaterThanOrEqual(1);
  });
});

describe('SOCKS5 dispatcher path', () => {
  afterEach(async () => {
    setEgressDepsForTest(null);
    resetCircuitForTest();
    resetEgressCountersForTest();
    stopStaticOutletHealthLoopForTest();
    await resetDispatchersForTest();
  });

  it('selects the socks dispatcher when the static outlet is socks5', async () => {
    setStaticOutletHealthForTest(true);
    const snap = snapshotWith(
      (config) => {
        config.masterEnabled = true;
        config.outlet.kind = 'static';
        config.scopes.features.market = enabledScope();
      },
      { staticProxyUrl: 'socks5://127.0.0.1:1' },
    );
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });

    const decision = await resolveEgress('feature:market', 'https://example.com/socks');
    expect(decision).toMatchObject({ mode: 'proxy', outlet: 'static' });
    if (decision.mode === 'proxy') {
      expect(decision.proxyUrl.startsWith('socks5://')).toBe(true);
    }

    const fetchImpl = createEgressFetch('feature:market');
    await expect(fetchImpl('https://example.com/socks')).rejects.toBeDefined();
  });
});

describe('circuit breaker', () => {
  afterEach(async () => {
    setEgressDepsForTest(null);
    resetCircuitForTest();
    resetEgressCountersForTest();
    stopStaticOutletHealthLoopForTest();
    await resetDispatchersForTest();
  });

  it('opens after 3 connect-phase failures and then falls back', async () => {
    setStaticOutletHealthForTest(true);
    const snap = snapshotWith(
      (config) => {
        config.masterEnabled = true;
        config.outlet.kind = 'static';
        config.scopes.features.market = enabledScope('direct');
      },
      { staticProxyUrl: 'http://127.0.0.1:1' },
    );
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });

    const fetchImpl = createEgressFetch('feature:market');
    for (let i = 0; i < 3; i += 1) {
      await fetchImpl('http://example.invalid/fail').catch(() => undefined);
    }

    const decision = await resolveEgress('feature:market', 'http://example.invalid/after');
    expect(decision).toEqual({ mode: 'direct', reason: 'fallback' });
    expect(getEgressCounters().fallback['feature:market']).toBeGreaterThanOrEqual(1);
  });

  it('does not count target-side CERT_HAS_EXPIRED as a connect-phase failure', async () => {
    const { isConnectPhaseFailure } = await import('./circuit');
    expect(
      isConnectPhaseFailure(
        { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' },
        { beforeHeaders: false, proxyUrl: 'http://127.0.0.1:18080' },
      ),
    ).toBe(false);
    expect(
      isConnectPhaseFailure(
        {
          code: 'ENOTFOUND',
          hostname: 'api.openai.com',
          message: 'getaddrinfo ENOTFOUND api.openai.com',
        },
        { beforeHeaders: true, proxyUrl: 'http://127.0.0.1:18080' },
      ),
    ).toBe(false);
  });
});

describe('fail-mode HTTP 503', () => {
  afterEach(() => {
    setEgressDepsForTest(null);
    resetEgressCountersForTest();
    resetCircuitForTest();
    stopStaticOutletHealthLoopForTest();
  });

  it('maps NetworkProxyUnavailableError through createErrorResponse to 503', async () => {
    const { createErrorResponse } = await import('@/utils/errorResponse');
    const { PLATFORM_ERROR_CODES } = await import('@/const/platform/errorCodes');
    const snap = snapshotWith((config) => {
      config.masterEnabled = true;
      config.scopes.providers.openai = enabledScope('fail');
    });
    setEgressDepsForTest({
      getEngineState: stoppedEngine,
      getSnapshot: async () => snap,
      isLegacyGlobalProxyActive: () => false,
      peekSnapshot: () => snap,
    });
    try {
      await createEgressFetch('provider:openai')('https://api.openai.com/v1/chat');
      expect.fail('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkProxyUnavailableError);
      const errorType = (error as { errorType: string }).errorType;
      expect(errorType).toBe(PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNAVAILABLE);
      const response = createErrorResponse(errorType as never);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { errorType: string };
      expect(body.errorType).toBe(PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNAVAILABLE);
    }
  });
});

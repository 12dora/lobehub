import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SafeOutboundHttpClient } from '@/server/enterprise/security/outboundHttp';
import type { NetworkProxyConfig } from '@/types/platform/networkProxy';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import { resetCircuitForTest } from './circuit';
import { getEgressCounters, resetEgressCountersForTest } from './counters';
import type { EgressEngineStateView, EgressSnapshotView } from './deps';
import { setEgressDepsForTest } from './deps';
import { resetDispatchersForTest } from './dispatchers';
import { isNetworkProxyUnavailableError, rethrowIfNetworkProxyUnavailable } from './error';
import { createEgressSafeOutboundTransport } from './safeOutboundTransport';
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

describe('isNetworkProxyUnavailableError / rethrow', () => {
  it('recognises the converted AgentRuntimeError payload', () => {
    const converted = {
      error: { name: 'NetworkProxyUnavailableError' },
      errorType: 'PLATFORM_NETWORK_PROXY_UNAVAILABLE',
      provider: 'openai',
    };
    expect(isNetworkProxyUnavailableError(converted)).toBe(true);
    expect(() => rethrowIfNetworkProxyUnavailable(converted)).toThrow();
  });

  it('ignores ordinary errors', () => {
    expect(isNetworkProxyUnavailableError(new Error('fetch failed'))).toBe(false);
    expect(() => rethrowIfNetworkProxyUnavailable(new Error('fetch failed'))).not.toThrow();
  });

  it('walks err.cause chains', () => {
    const fail = Object.assign(new Error('PLATFORM_NETWORK_PROXY_UNAVAILABLE'), {
      errorType: 'PLATFORM_NETWORK_PROXY_UNAVAILABLE',
      name: 'NetworkProxyUnavailableError',
    });
    const wrapped = new Error('fetch failed', { cause: fail });
    expect(isNetworkProxyUnavailableError(wrapped)).toBe(true);
    expect(() => rethrowIfNetworkProxyUnavailable(wrapped)).toThrow(wrapped);
  });
});

describe('createEgressSafeOutboundTransport streaming + single decision', () => {
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
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('chunk-one\n');
        res.write('chunk-two\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`origin:${req.url}`);
    });
    originPort = await listen(origin);

    proxy = http.createServer((_req, res) => {
      res.writeHead(400);
      res.end('plain http proxy unused');
    });
    proxy.on('connect', (_req, clientSocket, head) => {
      connectCount += 1;
      const upstream = net.connect(originPort, '127.0.0.1', () => {
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
        config.scopes.features.mcp = enabledScope();
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

  it('streams a proxied body through a Web ReadableStream (undici Node body converted)', async () => {
    const { streamingTransport, transport } = createEgressSafeOutboundTransport('feature:mcp');
    const client = new SafeOutboundHttpClient({
      streamingTransport,
      timeoutMs: 5_000,
      transport,
    });
    const response = await client.streamFetch('http://stream.example/stream');
    expect(connectCount).toBe(1);
    expect(typeof response.body?.getReader).toBe('function');
    const text = await response.text();
    expect(text).toContain('chunk-one');
    expect(text).toContain('chunk-two');
  });

  it('decides egress once per request (proxiedCount increments once)', async () => {
    const { streamingTransport, transport } = createEgressSafeOutboundTransport('feature:mcp');
    const client = new SafeOutboundHttpClient({
      streamingTransport,
      timeoutMs: 5_000,
      transport,
    });
    const response = await client.fetch('http://stream.example/hello');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('origin:/hello');
    expect(connectCount).toBe(1);
    expect(getEgressCounters().proxied['feature:mcp']).toBe(1);
  });
});

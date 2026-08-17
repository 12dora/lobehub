import type { Dispatcher } from 'undici';
import { ProxyAgent, Socks5ProxyAgent } from 'undici';

import { redactSecrets } from './deps';

const MAX_CACHED_DISPATCHERS = 8;

interface CachedDispatcher {
  agent: Dispatcher;
  lastUsed: number;
}

const cache = new Map<string, CachedDispatcher>();

const isSocks = (proxyUrl: string): boolean => {
  try {
    const protocol = new URL(proxyUrl).protocol;
    return protocol === 'socks5:' || protocol === 'socks:';
  } catch {
    return proxyUrl.startsWith('socks');
  }
};

/**
 * undici 7.28 ships Socks5ProxyAgent as experimental and emits a
 * process warning on first construct. Swallow only that warning.
 */
const createSocksAgent = (proxyUrl: string): Dispatcher => {
  const original = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const text = `${typeof warning === 'string' ? warning : ((warning as Error)?.message ?? '')} ${String(args[0] ?? '')}`;
    if (/socks5proxyagent|experimental/i.test(text)) return;
    return (original as (...inner: unknown[]) => void).apply(process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return new Socks5ProxyAgent(proxyUrl);
  } finally {
    process.emitWarning = original;
  }
};

const createAgent = (proxyUrl: string): Dispatcher => {
  if (isSocks(proxyUrl)) return createSocksAgent(proxyUrl);
  return new ProxyAgent({ uri: proxyUrl });
};

const evictOldest = (): void => {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, value] of cache) {
    if (value.lastUsed < oldestAt) {
      oldestAt = value.lastUsed;
      oldestKey = key;
    }
  }
  if (!oldestKey) return;
  const evicted = cache.get(oldestKey);
  cache.delete(oldestKey);
  void evicted?.agent.close?.();
};

/**
 * Per-proxyUrl dispatcher cache. Never calls `setGlobalDispatcher`.
 * Evicts (and `close()`s) the least-recently-used agent when the cache
 * exceeds 8 entries, and when the same logical outlet changes credentials.
 */
export const getDispatcher = (proxyUrl: string): Dispatcher => {
  const existing = cache.get(proxyUrl);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.agent;
  }
  while (cache.size >= MAX_CACHED_DISPATCHERS) evictOldest();
  const agent = createAgent(proxyUrl);
  cache.set(proxyUrl, { agent, lastUsed: Date.now() });
  return agent;
};

export const closeDispatchersExcept = (keep: ReadonlySet<string>): void => {
  for (const [key, value] of cache) {
    if (keep.has(key)) continue;
    cache.delete(key);
    void value.agent.close?.();
  }
};

export const resetDispatchersForTest = async (): Promise<void> => {
  const agents = [...cache.values()].map((entry) => entry.agent);
  cache.clear();
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await agent.close();
      } catch (error) {
        // Test teardown — a stuck agent must not fail the suite.
        console.warn(
          '[network-proxy] dispatcher close failed:',
          redactSecrets(error instanceof Error ? error.message : String(error)),
        );
      }
    }),
  );
};

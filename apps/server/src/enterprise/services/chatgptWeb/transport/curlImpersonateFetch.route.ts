import debug from 'debug';

import {
  createPersistentImpersonateFetch,
  drainAllPersistentTransport,
  drainPersistentTransportWhere,
  probeLibcurlImpersonate,
} from '../../browserSession/transport';
import {
  COOKIE_JAR_HEADER,
  createContextGoneError,
  getContextCookieJarPoolKey,
  isContextCookieJarKey,
  resolveCookieJarPath,
} from './cookieJar';
import { DEFAULT_IMPERSONATE_PROFILE } from './curlConfig';
import { createCurlImpersonateFetch } from './curlImpersonateFetch.cli';
import { ChatGPTWebTransportUnavailableError } from './errors';

const transportLog = debug('lobe-server:chatgpt-web:transport');

const CURL_CACHE_MAX = 4;
const keyed = new Map<string, { fetch: typeof fetch; lastUsed: number; proxyUrl: string }>();

export interface ChatGPTWebFetchOptions {
  impersonate?: string;
}

export const CHATGPT_WEB_TRANSPORT_ENV = 'CHATGPT_WEB_TRANSPORT';

export type ChatGPTWebTransportPref = 'auto' | 'persistent' | 'cli';

export interface ChatGPTWebTransportStatus {
  libraryVersion?: string;
  mode: 'persistent' | 'cli';
  reason?: string;
}

const readTransportPref = (env: NodeJS.ProcessEnv = process.env): ChatGPTWebTransportPref => {
  const raw = (env[CHATGPT_WEB_TRANSPORT_ENV] ?? 'auto').trim().toLowerCase();
  if (raw === 'persistent' || raw === 'cli' || raw === 'auto') return raw;
  return 'auto';
};

const describeRequestPath = (input: RequestInfo | URL): string => {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    return new URL(raw).pathname;
  } catch {
    return 'unknown';
  }
};

const peekCookieJarKey = (input: RequestInfo | URL, init?: RequestInit): string | undefined => {
  const headers = new Headers();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    input.headers.forEach((value, name) => {
      headers.set(name, value);
    });
  }
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
  }
  return headers.get(COOKIE_JAR_HEADER) || undefined;
};

const shouldUsePersistent = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  available: boolean,
): boolean => {
  if (!available) return false;
  const jarKey = peekCookieJarKey(input, init);
  if (!jarKey || !isContextCookieJarKey(jarKey)) return false;
  return available;
};

let loggedFallback = false;

export const getChatGPTWebTransportStatus = (): ChatGPTWebTransportStatus => {
  const pref = readTransportPref();
  // Kill switch: never probe / load / curl_global_init when forced to CLI.
  if (pref === 'cli') return { mode: 'cli', reason: `${CHATGPT_WEB_TRANSPORT_ENV}=cli` };
  const probe = probeLibcurlImpersonate();
  if (!probe.available) {
    return { mode: 'cli', reason: probe.reason ?? 'libcurl-impersonate is unavailable' };
  }
  return {
    mode: 'persistent',
    ...(probe.version ? { libraryVersion: probe.version } : {}),
  };
};

/**
 * Impersonated fetch keyed by outlet `proxyUrl` (LRU 4). Binary / library
 * resolution happens on the FIRST REQUEST, not at import time, so a
 * deployment without either still boots and only the ChatGPT Web provider
 * reports itself unavailable.
 *
 * Context-bound requests (`X-AIHub-Cookie-Jar` = registered digest) go
 * through the persistent libcurl-impersonate multi driver when available.
 * Legacy device-id jars and `CHATGPT_WEB_TRANSPORT=cli` stay on the CLI.
 */
export const getChatGPTWebFetch = (
  proxyUrl?: string | null,
  { impersonate = DEFAULT_IMPERSONATE_PROFILE }: ChatGPTWebFetchOptions = {},
): typeof fetch => {
  const pref = readTransportPref();
  // Kill switch: branch on `cli` before any probe / koffi.load / curl_global_init.
  if (pref === 'cli') {
    return getOrCreateCliFetch(proxyUrl, impersonate);
  }

  const probe = probeLibcurlImpersonate();
  if (pref === 'persistent' && !probe.available) {
    throw new ChatGPTWebTransportUnavailableError(
      `ChatGPT Web transport unavailable: ${CHATGPT_WEB_TRANSPORT_ENV}=persistent but libcurl-impersonate is not available${
        probe.reason ? ` (${probe.reason})` : ''
      }.`,
    );
  }
  if (!probe.available && !loggedFallback) {
    loggedFallback = true;
    transportLog(
      'persistent impersonated transport unavailable, using CLI: %s',
      probe.reason ?? 'unknown',
    );
  }

  return getOrCreateRoutedFetch(proxyUrl, impersonate, probe.available);
};

const evictOldest = (): void => {
  while (keyed.size >= CURL_CACHE_MAX) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [entryKey, value] of keyed) {
      if (value.lastUsed < oldestAt) {
        oldestAt = value.lastUsed;
        oldestKey = entryKey;
      }
    }
    if (oldestKey !== undefined) keyed.delete(oldestKey);
    else break;
  }
};

const getOrCreateCliFetch = (
  proxyUrl: string | null | undefined,
  impersonate: string,
): typeof fetch => {
  const resolvedProxyUrl = proxyUrl ?? '';
  const key = `cli\n${impersonate}\n${resolvedProxyUrl}`;
  const existing = keyed.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.fetch;
  }
  evictOldest();
  const inner = createCurlImpersonateFetch({
    impersonate,
    ...(resolvedProxyUrl ? { proxyUrl: resolvedProxyUrl } : {}),
  });
  const impl: typeof fetch = (async (input, init) => {
    transportLog('request transport=cli path=%s', describeRequestPath(input));
    return inner(input, init);
  }) as typeof fetch;
  keyed.set(key, { fetch: impl, lastUsed: Date.now(), proxyUrl: resolvedProxyUrl });
  return impl;
};

const getOrCreateRoutedFetch = (
  proxyUrl: string | null | undefined,
  impersonate: string,
  persistentAvailable: boolean,
): typeof fetch => {
  const resolvedProxyUrl = proxyUrl ?? '';
  const key = `${impersonate}\n${resolvedProxyUrl}`;
  const existing = keyed.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.fetch;
  }
  evictOldest();

  const cli = createCurlImpersonateFetch({
    impersonate,
    ...(resolvedProxyUrl ? { proxyUrl: resolvedProxyUrl } : {}),
  });

  let persistent: typeof fetch | undefined;
  if (persistentAvailable) {
    persistent = createPersistentImpersonateFetch({
      impersonate,
      ...(resolvedProxyUrl ? { proxyUrl: resolvedProxyUrl } : {}),
      resolvePool: (jarKey) => {
        if (!isContextCookieJarKey(jarKey)) return undefined;
        const poolScope = getContextCookieJarPoolKey(jarKey);
        if (!poolScope) throw createContextGoneError();
        return { cookieJarPath: resolveCookieJarPath(jarKey), poolScope };
      },
    });
  }

  const impl: typeof fetch = (async (input, init) => {
    if (persistent && shouldUsePersistent(input, init, persistentAvailable)) {
      transportLog('request transport=persistent-ffi path=%s', describeRequestPath(input));
      return persistent(input, init);
    }
    transportLog('request transport=cli path=%s', describeRequestPath(input));
    return cli(input, init);
  }) as typeof fetch;

  keyed.set(key, { fetch: impl, lastUsed: Date.now(), proxyUrl: resolvedProxyUrl });
  return impl;
};

/**
 * Drop cached CLI/routed fetchers whose outlet is not in `keep`. Also drain
 * EVERY persistent pool with a non-empty proxy outlet: a stable local mihomo
 * URL can hide an upstream node switch, so proxied connections are cheap to
 * reopen rather than reuse.
 */
export const evictChatGPTWebFetchExcept = (keep: ReadonlySet<string>): void => {
  for (const [key, value] of keyed) {
    if (value.proxyUrl && !keep.has(value.proxyUrl)) keyed.delete(key);
  }
  void drainPersistentTransportWhere((pool) => Boolean(pool.proxyOutlet));
};

/** Test seam only. */
export const resetChatGPTWebFetch = (): void => {
  keyed.clear();
  void drainAllPersistentTransport();
  loggedFallback = false;
};

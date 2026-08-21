import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import debug from 'debug';

import { isBrowserCookieJarTombstoned } from '../../browserSession/cookieJar';
import {
  createPersistentImpersonateFetch,
  drainAllPersistentTransport,
  drainPersistentTransportWhere,
  probeLibcurlImpersonate,
} from '../../browserSession/transport';
import { registerBrowserSessionScopeDrain } from '../../browserSession/transportPool';
import { redactSecrets } from '../../networkProxy/redact';
import { removeQuietly, writeRequestBodyFile } from './bodyFile';
import { createBodyStream } from './bodyStream';
import {
  COOKIE_JAR_HEADER,
  createContextGoneError,
  ensureCookieJarFile,
  getContextCookieJarPoolKey,
  isContextCookieJarKey,
  resolveCookieJarPath,
  seedCookieJar,
  stripCookieJarHeader,
} from './cookieJar';
import {
  buildInvocation,
  DEFAULT_IMPERSONATE_PROFILE,
  fetchFailed,
  MAX_STDERR_BYTES,
  readEnv,
} from './curlConfig';
import { buildResponse } from './curlResponse';
import { ChatGPTWebTransportUnavailableError } from './errors';
import { HeaderDumpReader, type HeaderDumpSplit } from './headerDump';
import { createAbortError, normalizeRequest } from './request';
import { resolveCurlImpersonateBinary, resolveCurlImpersonateBinaryCached } from './resolveBinary';

const transportLog = debug('lobe-server:chatgpt-web:transport');

/**
 * fetch-compatible transport backed by `curl-impersonate`.
 *
 * chatgpt.com answers Node's own fetch with a Cloudflare bot challenge (403,
 * `cf-mitigated: challenge`) whatever headers are sent — the TLS/HTTP2 fingerprint is
 * what is being checked. Spawning a browser-fingerprinted curl is therefore not an
 * optimisation but the only way the provider works at all.
 *
 * Contract kept deliberately close to WHATWG fetch: a real `Response` with a streaming
 * body, `AbortSignal` support, no redirect following, and undici-shaped network errors.
 */

export { DEFAULT_IMPERSONATE_PROFILE };

const KILL_GRACE_MS = 2000;
/**
 * A caller that takes the `Response` and never reads (or cancels) its body leaves curl
 * blocked on a full pipe for the whole `--max-time` budget. One wedged SSE stream is a
 * leaked child process plus a leaked upstream connection, so an unread body is killed.
 */
const BODY_STALL_TIMEOUT_MS = 60_000;

interface TrackedCurlChild {
  close: Promise<void>;
  kill: () => void;
  scopes: Set<string>;
}

const trackedCurlChildren = new Set<TrackedCurlChild>();

const awaitChildCloses = async (victims: TrackedCurlChild[]): Promise<void> => {
  const results = await Promise.allSettled(
    victims.map((child) => Promise.resolve().then(() => child.close)),
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected.length === 0) return;
  const detail = rejected
    .map((result) => (result.reason instanceof Error ? result.reason.message : 'UnknownError'))
    .join('; ');
  throw new AggregateError(
    rejected.map((result) => result.reason),
    `curl-impersonate child drain failed: ${detail}`,
  );
};

export const drainCurlImpersonateChildren = async (scope: string): Promise<void> => {
  const victims = [...trackedCurlChildren].filter((child) => child.scopes.has(scope));
  for (const child of victims) child.kill();
  await awaitChildCloses(victims);
};

export const drainAllCurlImpersonateChildren = async (): Promise<void> => {
  const victims = [...trackedCurlChildren];
  for (const child of victims) child.kill();
  await awaitChildCloses(victims);
};

export const trackedCurlChildCountForTests = (): number => trackedCurlChildren.size;

registerBrowserSessionScopeDrain(drainCurlImpersonateChildren, drainAllCurlImpersonateChildren);

export interface CurlImpersonateFetchOptions {
  /** Absolute path to the binary; overrides env + PATH discovery. */
  binaryPath?: string;
  /** How long an unread (back-pressured) response body may stall before the child is killed. */
  bodyStallTimeoutMs?: number;
  /** CA bundle passed as `--cacert`; falls back to SSL_CERT_FILE / NODE_EXTRA_CA_CERTS. */
  caBundle?: string;
  /**
   * Factory-level Netscape jar (`cookie` / `cookie-jar`). Per-request
   * `X-AIHub-Cookie-Jar` overrides this. A context digest maps to the
   * Browser Session Context jar; a legacy device id still maps to
   * `$TMPDIR/aihub-chatgptweb-jars/<sha256(deviceId)>.txt` and seeds `oai-did`.
   * The header is stripped before spawn and never forwarded.
   */
  cookieJarPath?: string;
  /** `--max-time` budget for a whole request/response. */
  defaultTimeoutMs?: number;
  /** curl-impersonate browser profile. */
  impersonate?: string;
  /** `-x` proxy; falls back to PROXY_URL / HTTPS_PROXY. */
  proxyUrl?: string;
}

export const createCurlImpersonateFetch = (
  options: CurlImpersonateFetchOptions = {},
): typeof fetch => {
  // Per-factory memo: an explicit `binaryPath` must not poison (or be poisoned by) the
  // shared, env-driven module cache.
  let resolvedBinary: string | undefined;

  const impersonateFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = await normalizeRequest(input, init);
    const settings = readEnv(options, process.env);
    resolvedBinary ??= options.binaryPath
      ? resolveCurlImpersonateBinary({ override: options.binaryPath })
      : resolveCurlImpersonateBinaryCached();
    const binary = resolvedBinary;

    if (request.signal?.aborted) throw createAbortError();

    // `X-AIHub-Cookie-Jar` is a private hop-by-hop header: map it to a jar and
    // drop it so curl never sends it upstream. A context-scoped key is a digest
    // (or path) and must NOT be written as `oai-did` — that cookie is the
    // ChatGPT device id, seeded when the context is acquired.
    const stripped = stripCookieJarHeader(request.headers);
    let cookieJarPath = options.cookieJarPath;
    if (stripped.cookieJarKey) {
      cookieJarPath = resolveCookieJarPath(stripped.cookieJarKey);
      if (cookieJarPath && isBrowserCookieJarTombstoned(cookieJarPath)) {
        if (isContextCookieJarKey(stripped.cookieJarKey)) throw createContextGoneError();
        cookieJarPath = undefined;
      } else if (
        cookieJarPath &&
        !isContextCookieJarKey(stripped.cookieJarKey) &&
        !stripped.cookieJarKey.startsWith('/') &&
        !stripped.cookieJarKey.includes('/')
      ) {
        seedCookieJar(cookieJarPath, [
          { domain: '.chatgpt.com', name: 'oai-did', value: stripped.cookieJarKey },
        ]);
      } else if (cookieJarPath) {
        ensureCookieJarFile(cookieJarPath);
      }
    } else if (cookieJarPath && isBrowserCookieJarTombstoned(cookieJarPath)) {
      cookieJarPath = undefined;
    } else if (cookieJarPath) {
      ensureCookieJarFile(cookieJarPath);
    }

    let tempBodyPath: string | undefined;
    let tempBodyRemoved = false;
    const removeTempBody = () => {
      if (tempBodyRemoved) return;
      tempBodyRemoved = true;
      removeQuietly(tempBodyPath);
    };

    if (request.body) {
      try {
        tempBodyPath = writeRequestBodyFile(request.body);
      } catch (error) {
        throw new ChatGPTWebTransportUnavailableError(
          `ChatGPT Web transport unavailable: the request body could not be staged (${(error as Error).message}).`,
        );
      }
    }

    const invocation = buildInvocation({
      ...(tempBodyPath ? { bodyFilePath: tempBodyPath } : {}),
      caBundle: settings.caBundle,
      ...(cookieJarPath ? { cookieJarPath } : {}),
      dropHeaders: request.dropHeaders.filter(
        (name) => name.toLowerCase() !== COOKIE_JAR_HEADER.toLowerCase(),
      ),
      headers: stripped.headers,
      impersonate: settings.impersonate,
      method: request.method,
      proxyUrl: settings.proxyUrl,
      timeoutMs: settings.timeoutMs,
      url: request.url,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      // stdin = curl config (us → child), stdout = header dump followed by the body.
      child = spawn(binary, invocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      removeTempBody();
      throw new ChatGPTWebTransportUnavailableError(
        `ChatGPT Web transport unavailable: failed to start curl-impersonate (${(error as Error).message}).`,
      );
    }

    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (killed) return;
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const scopes = new Set<string>();
    if (cookieJarPath) scopes.add(cookieJarPath);
    if (stripped.cookieJarKey) {
      scopes.add(stripped.cookieJarKey);
      const poolKey = getContextCookieJarPoolKey(stripped.cookieJarKey);
      if (poolKey) scopes.add(poolKey);
    }
    const close = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    const tracked: TrackedCurlChild = { close, kill, scopes };
    trackedCurlChildren.add(tracked);
    void close.finally(() => {
      trackedCurlChildren.delete(tracked);
    });

    const body = createBodyStream({
      kill,
      stallTimeoutMs: options.bodyStallTimeoutMs ?? BODY_STALL_TIMEOUT_MS,
      stdout: child.stdout,
    });
    const headerReader = new HeaderDumpReader();

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Slice the chunk: a single oversized write must not blow past the bound.
      if (stderr.length >= MAX_STDERR_BYTES) return;
      stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
    });

    let settleResponse: ((response: Response) => void) | undefined;
    let settleError: ((error: unknown) => void) | undefined;
    let responseSettled = false;
    const responsePromise = new Promise<Response>((resolve, reject) => {
      settleResponse = (response) => {
        if (responseSettled) return;
        responseSettled = true;
        resolve(response);
      };
      settleError = (error) => {
        if (responseSettled) return;
        responseSettled = true;
        reject(error);
      };
    });

    /**
     * stdout carries the header dump and then the body, so every chunk goes through the
     * splitter first. Body bytes routinely share the chunk that completes the head, and
     * the terminating blank line can straddle two chunks — both are the splitter's job.
     */
    let responded = false;
    child.stdout.on('data', (chunk: Buffer) => {
      let split: HeaderDumpSplit | undefined;
      try {
        split = headerReader.push(chunk);
      } catch (error) {
        // Only the header-size guard throws here.
        const failure = new TypeError(`fetch failed: ${(error as Error).message}`);
        settleError?.(failure);
        body.fail(failure);
        kill();
        return;
      }
      if (!split) return;
      if (!responded) {
        responded = true;
        settleResponse?.(buildResponse(split.head, body.stream, request.url));
      }
      if (split.body.byteLength > 0) body.push(split.body);
    });
    // stdout ending without a complete block is handled by the `close` handler below.
    child.stdout.on('error', () => undefined);

    /**
     * The abort listener is per-request but the signal usually is NOT (one controller can
     * cover a whole conversation). Without this removal every request would leave a
     * closure — child process, streams and all — attached to a long-lived signal.
     */
    const onAbort = () => {
      const abortError = createAbortError();
      settleError?.(abortError);
      body.fail(abortError);
      kill();
      // The child is on its way out and an unlinked file stays readable through the fd it
      // already holds, so the bytes never outlive the request even if SIGTERM is slow.
      removeTempBody();
    };
    const detachAbort = () => request.signal?.removeEventListener('abort', onAbort);

    child.on('error', (error) => {
      detachAbort();
      removeTempBody();
      // spawn failure surfaces here on some platforms (ENOENT after the sync call).
      const failure = new ChatGPTWebTransportUnavailableError(
        `ChatGPT Web transport unavailable: curl-impersonate could not run (${error.message}).`,
      );
      settleError?.(failure);
      body.fail(failure);
    });

    child.on('close', (code) => {
      detachAbort();
      removeTempBody();
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        if (!headerReader.head) {
          settleError?.(fetchFailed(code, 'no response headers were received'));
        }
        body.finish();
        return;
      }

      const failure = fetchFailed(code, redactSecrets(stderr));
      // Before the head: a network-style rejection, exactly like undici.
      // After it: the caller already has a Response, so the failure belongs on the body.
      settleError?.(failure);
      body.fail(failure);
    });

    request.signal?.addEventListener('abort', onAbort, { once: true });

    // `--config -` reads stdin to EOF before the connection is opened, so the whole
    // (small) config is written up-front and the pipe is closed with it — otherwise curl
    // would wait for more config forever. The request body is NOT here: it is on disk,
    // referenced by `data-binary = "@…"` inside this config.
    child.stdin.on('error', () => undefined);
    child.stdin.end(invocation.config);

    return responsePromise;
  };

  return impersonateFetch as typeof fetch;
};

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

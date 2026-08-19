/**
 * fetch-compatible transport backed by in-process libcurl-impersonate.
 *
 * Same contract as `createCurlImpersonateFetch`: WHATWG Response with a
 * streaming body, AbortSignal, no redirect following, undici-shaped errors.
 * Pool key = browser context (via `resolvePool`) + origin + proxy outlet +
 * impersonation profile. The Netscape jar file stays the cookie source of
 * truth; this layer never interprets ChatGPT cookies.
 */
import { COOKIE_JAR_HEADER, stripCookieJarHeader } from '../../chatgptWeb/transport/cookieJar';
import { readEnv } from '../../chatgptWeb/transport/curlConfig';
import { ChatGPTWebTransportUnavailableError } from '../../chatgptWeb/transport/errors';
import { createAbortError, normalizeRequest } from '../../chatgptWeb/transport/request';
import { ensureBrowserCookieJarFile, isBrowserCookieJarTombstoned } from '../cookieJar';
import { buildBrowserSessionTransportPoolKey } from '../transportPool';
import { probeLibcurlImpersonate } from './libcurlFfi';
import type { LibcurlMultiDriver, LibcurlPoolIdentity } from './multiDriver';
import {
  drainAllSharedLibcurlPools,
  drainSharedLibcurlPools,
  drainSharedLibcurlPoolsWhere,
  getSharedLibcurlMultiDriver,
} from './multiDriver';

export interface PersistentPoolResolution {
  cookieJarPath: string;
  poolScope: string;
}

export interface PersistentImpersonateFetchOptions {
  bodyStallTimeoutMs?: number;
  caBundle?: string;
  cookieJarPath?: string;
  defaultPoolScope?: string;
  defaultTimeoutMs?: number;
  /** Test seam: inject a driver. */
  driver?: LibcurlMultiDriver;
  impersonate?: string;
  proxyUrl?: string;
  /**
   * Map the private `X-AIHub-Cookie-Jar` value to a jar path + pool scope.
   * Provider-specific (ChatGPT context digest → context.transportPoolKey).
   */
  resolvePool?: (jarKey: string) => PersistentPoolResolution | undefined;
}

const DEFAULT_UNSCOPED_POOL = 'unscoped';

export const CONTEXT_GONE_ERROR = 'fetch failed: browser session context is gone';

const peekCookieJarKey = (input: RequestInfo | URL, init?: RequestInit): string | undefined => {
  const headers = new Headers();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    input.headers.forEach((value, name) => headers.set(name, value));
  }
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  return headers.get(COOKIE_JAR_HEADER) || undefined;
};

export const createPersistentImpersonateFetch = (
  options: PersistentImpersonateFetchOptions = {},
): typeof fetch => {
  const probe = probeLibcurlImpersonate();
  if (!probe.available) {
    throw new ChatGPTWebTransportUnavailableError(
      `ChatGPT Web transport unavailable: persistent libcurl-impersonate is not available${
        probe.reason ? ` (${probe.reason})` : ''
      }.`,
    );
  }

  const driver = options.driver ?? getSharedLibcurlMultiDriver();

  const impersonateFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const jarKeyBefore = peekCookieJarKey(input, init);
    const contextBound = Boolean(jarKeyBefore && options.resolvePool?.(jarKeyBefore));

    const request = await normalizeRequest(input, init);
    const settings = readEnv(options, process.env);
    if (request.signal?.aborted) throw createAbortError();

    const stripped = stripCookieJarHeader(request.headers);
    const dropHeaders = request.dropHeaders.filter(
      (name) => name.toLowerCase() !== COOKIE_JAR_HEADER.toLowerCase(),
    );

    let cookieJarPath = options.cookieJarPath;
    let poolScope = options.defaultPoolScope ?? DEFAULT_UNSCOPED_POOL;
    const jarKey = stripped.cookieJarKey ?? (contextBound ? jarKeyBefore : undefined);
    if (jarKey || contextBound) {
      const key = jarKey ?? jarKeyBefore;
      const resolved = key ? options.resolvePool?.(key) : undefined;
      if (!resolved) throw new TypeError(CONTEXT_GONE_ERROR);
      cookieJarPath = resolved.cookieJarPath;
      poolScope = resolved.poolScope;
    }
    if (cookieJarPath && isBrowserCookieJarTombstoned(cookieJarPath)) {
      if (contextBound) throw new TypeError(CONTEXT_GONE_ERROR);
      cookieJarPath = undefined;
    } else if (cookieJarPath) {
      ensureBrowserCookieJarFile(cookieJarPath);
    }

    const origin = new URL(request.url).origin;
    const proxyOutlet = settings.proxyUrl ?? '';
    const identity: LibcurlPoolIdentity = {
      key: buildBrowserSessionTransportPoolKey({
        contextId: poolScope,
        impersonationProfileRevision: settings.impersonate,
        origin,
        proxyOutlet,
      }),
      origin,
      proxyOutlet,
      scope: poolScope,
    };

    return driver.submit(identity, {
      ...(request.body ? { body: request.body } : {}),
      bodyStallTimeoutMs: options.bodyStallTimeoutMs,
      ...(settings.caBundle ? { caBundle: settings.caBundle } : {}),
      ...(cookieJarPath ? { cookieJarPath } : {}),
      dropHeaders,
      headers: stripped.headers,
      impersonate: settings.impersonate,
      method: request.method,
      ...(settings.proxyUrl ? { proxyUrl: settings.proxyUrl } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      timeoutMs: settings.timeoutMs,
      url: request.url,
    });
  };

  return impersonateFetch as typeof fetch;
};

export const drainPersistentTransportForScope = (transportPoolKeyOrScope: string): Promise<void> =>
  drainSharedLibcurlPools(transportPoolKeyOrScope);

export const drainPersistentTransportWhere = (
  predicate: (pool: LibcurlPoolIdentity) => boolean,
): Promise<void> => drainSharedLibcurlPoolsWhere(predicate);

export const drainAllPersistentTransport = (): Promise<void> => drainAllSharedLibcurlPools();

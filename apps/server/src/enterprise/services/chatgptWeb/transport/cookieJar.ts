import { COOKIE_JAR_HEADER } from '@lobechat/model-runtime/chatgptWebIdentity';

import type { CookieSeed } from '@/server/enterprise/services/browserSession/cookieJar';
import {
  deleteBrowserCookieJar,
  ensureBrowserCookieJarFile,
  isBrowserCookieJarTombstoned,
  LEGACY_DEVICE_BROWSER_COOKIE_JAR_DIR_NAME,
  resetBrowserCookieJars,
  resolveBrowserCookieJarPath,
  seedBrowserCookieJar,
} from '@/server/enterprise/services/browserSession/cookieJar';

/**
 * Private hop-by-hop header. Runtime / oauth set this to the connection
 * `deviceId`. This transport strips it before spawning curl and never forwards
 * it upstream. Defined in the runtime (`sessionId.ts`) so both sides agree.
 */
export { COOKIE_JAR_HEADER };

export type { CookieSeed };

const JAR_DIR_NAME = LEGACY_DEVICE_BROWSER_COOKIE_JAR_DIR_NAME;

/** Deterministic Netscape jar path: `$TMPDIR/aihub-chatgptweb-jars/<sha256(connectionKey)>.txt`. */
export const getCookieJarPath = (connectionKey: string): string =>
  resolveBrowserCookieJarPath({ directoryName: JAR_DIR_NAME, key: connectionKey });

/**
 * Create the jar file at 0600 inside a 0700 directory when it does not exist.
 * Safe to call on every request; existing files are only chmod'd.
 */
export const ensureCookieJarFile = (path: string): void => {
  if (isBrowserCookieJarTombstoned(path)) return;
  ensureBrowserCookieJarFile(path);
};

/**
 * Write or replace Netscape cookie lines. Existing cookies whose family is not
 * in the seed are kept — curl's `__cf_bm` / `_cfuvid` survive a re-seed of
 * `oai-did` or the vault session token.
 */
export const seedCookieJar = (path: string, cookies: CookieSeed[]): void => {
  seedBrowserCookieJar(path, cookies);
};

/** Vault-authoritative session cookies for a connection. Call on every renewal. */
export const seedSessionJar = (deviceId: string, sessionToken?: string): string => {
  const path = getCookieJarPath(deviceId);
  const seeds: CookieSeed[] = [{ domain: '.chatgpt.com', name: 'oai-did', value: deviceId }];
  if (sessionToken) {
    seeds.push({
      domain: '.chatgpt.com',
      httpOnly: true,
      name: '__Secure-next-auth.session-token',
      value: sessionToken,
    });
  }
  seedCookieJar(path, seeds);
  return path;
};

export const deleteCookieJar = (connectionKey: string): void => {
  deleteBrowserCookieJar(getCookieJarPath(connectionKey));
};

export const CONTEXT_GONE_ERROR = 'fetch failed: browser session context is gone';

export const createContextGoneError = (): TypeError => new TypeError(CONTEXT_GONE_ERROR);

const SHA256_HEX = /^[\da-f]{64}$/i;

/** Context digests are sha256 hex; legacy device ids are UUIDs (or other non-digest keys). */
export const isBrowserSessionContextDigestShape = (key: string): boolean => SHA256_HEX.test(key);

const RETIRED_CAP = 4096;
const retiredContextDigests = new Map<string, number>();

const rememberRetiredContextDigest = (digest: string): void => {
  retiredContextDigests.delete(digest);
  retiredContextDigests.set(digest, Date.now());
  while (retiredContextDigests.size > RETIRED_CAP) {
    const oldest = retiredContextDigests.keys().next().value;
    if (oldest === undefined) break;
    retiredContextDigests.delete(oldest);
  }
};

/**
 * Drain persistent pools, dispose live browser-session contexts, then clear
 * mappings and unlink jars. Profile regeneration invalidates every context.
 *
 * Order: fence routing for every context key → dispose registry → await
 * pending cleanup + drainAll → only then clear mappings / unlink / tombstones.
 */
export const resetCookieJars = (): void | Promise<void> => {
  const finish = (): void => {
    contextJarPaths.clear();
    contextJarPoolKeys.clear();
    resetBrowserCookieJars();
  };

  const run = async (): Promise<void> => {
    for (const digest of Array.from(contextJarPaths.keys())) {
      rememberRetiredContextDigest(digest);
      contextJarPaths.delete(digest);
      contextJarPoolKeys.delete(digest);
    }

    const { getBrowserSessionRegistry } = await import('../../browserSession/contextRegistry');
    const registry = getBrowserSessionRegistry();
    registry.dispose();
    await registry.awaitPendingCleanup();

    try {
      const { drainAllPersistentTransport } =
        await import('../../browserSession/transport/persistentFetch');
      await drainAllPersistentTransport();
    } catch (error) {
      console.error('[chatgpt-web] persistent drainAll during jar reset failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    try {
      const { drainAllCurlImpersonateChildren } = await import('./curlImpersonateFetch');
      await drainAllCurlImpersonateChildren();
    } catch (error) {
      console.error('[chatgpt-web] CLI child drain during jar reset failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    finish();
  };

  return run();
};

/**
 * Context-owned jars register digest → path here so `X-AIHub-Cookie-Jar` can
 * carry a secret-safe digest instead of a filesystem path or a raw device id.
 * Legacy callers still send a device id; those resolve through {@link getCookieJarPath}.
 */
const contextJarPaths = new Map<string, string>();
/** digest → context.transportPoolKey (pool scope for C3). */
const contextJarPoolKeys = new Map<string, string>();

export const registerContextCookieJar = (
  digest: string,
  path: string,
  transportPoolKey?: string,
): void => {
  retiredContextDigests.delete(digest);
  contextJarPaths.set(digest, path);
  if (transportPoolKey) contextJarPoolKeys.set(digest, transportPoolKey);
  else contextJarPoolKeys.delete(digest);
};

export const unregisterContextCookieJar = (digest: string): void => {
  if (contextJarPaths.has(digest) || isBrowserSessionContextDigestShape(digest)) {
    rememberRetiredContextDigest(digest);
  }
  contextJarPaths.delete(digest);
  contextJarPoolKeys.delete(digest);
};

/** Context transport-pool key registered alongside the jar digest. */
export const getContextCookieJarPoolKey = (digest: string): string | undefined =>
  contextJarPoolKeys.get(digest);

const isRetiredOrDigestContextKey = (key: string): boolean =>
  retiredContextDigests.has(key) || isBrowserSessionContextDigestShape(key);

/** Absolute paths, registered context digests, or the legacy device-id key. */
export const resolveCookieJarPath = (key: string): string => {
  const registered = contextJarPaths.get(key);
  if (registered) return registered;
  if (key.startsWith('/') || key.includes('/')) return key;
  if (isRetiredOrDigestContextKey(key)) throw createContextGoneError();
  return getCookieJarPath(key);
};

/** True when `key` names a context jar (do not seed `oai-did` from the key). */
export const isContextCookieJarKey = (key: string): boolean =>
  contextJarPaths.has(key) ||
  isRetiredOrDigestContextKey(key) ||
  key.startsWith('/') ||
  key.includes('/');

export const isRetiredContextCookieJarKey = (key: string): boolean =>
  retiredContextDigests.has(key);

const COOKIE_JAR_HEADER_LOWER = COOKIE_JAR_HEADER.toLowerCase();

/**
 * Pull the private jar header out of the sanitized request. The remaining list
 * is what curl is allowed to send.
 */
export const stripCookieJarHeader = (
  headers: [string, string][],
): { cookieJarKey?: string; headers: [string, string][] } => {
  let cookieJarKey: string | undefined;
  const kept: [string, string][] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() === COOKIE_JAR_HEADER_LOWER) {
      if (value) cookieJarKey = value;
      continue;
    }
    kept.push([name, value]);
  }
  return cookieJarKey ? { cookieJarKey, headers: kept } : { headers: kept };
};

export const withCookieJarHeader = (
  headers: Record<string, string>,
  jarKey?: string,
): Record<string, string> => (jarKey ? { ...headers, [COOKIE_JAR_HEADER]: jarKey } : headers);

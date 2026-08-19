import { COOKIE_JAR_HEADER } from '@lobechat/model-runtime/chatgptWebIdentity';

import type { CookieSeed } from '@/server/enterprise/services/browserSession/cookieJar';
import {
  deleteBrowserCookieJar,
  ensureBrowserCookieJarFile,
  isBrowserCookieJarTombstoned,
  LEGACY_DEVICE_BROWSER_COOKIE_JAR_DIR_NAME,
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

/** On-the-wire namespace for context-owned jars. Classify ownership only by this prefix. */
export const CONTEXT_COOKIE_JAR_KEY_PREFIX = 'ctx:';

export const toContextCookieJarKey = (digest: string): string =>
  digest.startsWith(CONTEXT_COOKIE_JAR_KEY_PREFIX)
    ? digest
    : `${CONTEXT_COOKIE_JAR_KEY_PREFIX}${digest}`;

/** True when `key` is a namespaced context jar (`ctx:<sha256>`). Never infer from hex shape. */
export const isContextCookieJarKey = (key: string): boolean =>
  key.startsWith(CONTEXT_COOKIE_JAR_KEY_PREFIX);

/** @deprecated Use {@link isContextCookieJarKey}. Kept so existing re-exports keep compiling. */
export const isBrowserSessionContextDigestShape = isContextCookieJarKey;

const RETIRED_CAP = 4096;
const retiredContextDigests = new Map<string, number>();

const rememberRetiredContextDigest = (digest: string): void => {
  const key = toContextCookieJarKey(digest);
  retiredContextDigests.delete(key);
  retiredContextDigests.set(key, Date.now());
  while (retiredContextDigests.size > RETIRED_CAP) {
    const oldest = retiredContextDigests.keys().next().value;
    if (oldest === undefined) break;
    retiredContextDigests.delete(oldest);
  }
};

const logDrainRejection = (label: string, reason: unknown): void => {
  console.error(`[chatgpt-web] ${label} during jar reset failed`, {
    errorClass: reason instanceof Error ? reason.name : 'UnknownError',
  });
};

/**
 * Drain persistent pools, dispose live browser-session contexts, then clear
 * mappings and unlink jars. Profile regeneration invalidates every context.
 *
 * Order: retire routing keys → mark registry disposed → drop contexts → await
 * pending cleanup + drainAll → only then unlink jars → atomically install a
 * fresh registry. Never unlinks jars belonging to the replacement.
 */
export const resetCookieJars = (): void | Promise<void> => {
  const run = async (): Promise<void> => {
    for (const digest of Array.from(contextJarPaths.keys())) {
      rememberRetiredContextDigest(digest);
      contextJarPaths.delete(digest);
      contextJarPoolKeys.delete(digest);
    }

    const { resetAndReplaceBrowserSessionRegistryAfter } =
      await import('../../browserSession/contextRegistry');

    await resetAndReplaceBrowserSessionRegistryAfter(async () => {
      const { drainAllPersistentTransport } =
        await import('../../browserSession/transport/persistentFetch');
      const { drainAllCurlImpersonateChildren } = await import('./curlImpersonateFetch');
      const results = await Promise.allSettled([
        drainAllPersistentTransport(),
        drainAllCurlImpersonateChildren(),
      ]);
      if (results[0]?.status === 'rejected') {
        logDrainRejection('persistent drainAll', results[0].reason);
      }
      if (results[1]?.status === 'rejected') {
        logDrainRejection('CLI child drain', results[1].reason);
      }
    });
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
  const key = toContextCookieJarKey(digest);
  retiredContextDigests.delete(key);
  contextJarPaths.set(key, path);
  if (transportPoolKey) contextJarPoolKeys.set(key, transportPoolKey);
  else contextJarPoolKeys.delete(key);
};

export const unregisterContextCookieJar = (digest: string): void => {
  const key = toContextCookieJarKey(digest);
  rememberRetiredContextDigest(key);
  contextJarPaths.delete(key);
  contextJarPoolKeys.delete(key);
};

/** Context transport-pool key registered alongside the namespaced jar key. */
export const getContextCookieJarPoolKey = (digest: string): string | undefined =>
  contextJarPoolKeys.get(digest) ?? contextJarPoolKeys.get(toContextCookieJarKey(digest));

/** Absolute paths, registered `ctx:<sha256>` keys, or the legacy device-id key. */
export const resolveCookieJarPath = (key: string): string => {
  const registered = contextJarPaths.get(key);
  if (registered) return registered;
  if (key.startsWith('/') || key.includes('/')) return key;
  if (isContextCookieJarKey(key)) throw createContextGoneError();
  return getCookieJarPath(key);
};

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

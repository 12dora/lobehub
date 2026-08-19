import { COOKIE_JAR_HEADER } from '@lobechat/model-runtime/chatgptWebIdentity';

import type { CookieSeed } from '@/server/enterprise/services/browserSession/cookieJar';
import {
  deleteBrowserCookieJar,
  ensureBrowserCookieJarFile,
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

const JAR_DIR_NAME = 'aihub-chatgptweb-jars';

/** Deterministic Netscape jar path: `$TMPDIR/aihub-chatgptweb-jars/<sha256(connectionKey)>.txt`. */
export const getCookieJarPath = (connectionKey: string): string =>
  resolveBrowserCookieJarPath({ directoryName: JAR_DIR_NAME, key: connectionKey });

/**
 * Create the jar file at 0600 inside a 0700 directory when it does not exist.
 * Safe to call on every request; existing files are only chmod'd.
 */
export const ensureCookieJarFile = (path: string): void => {
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

/** Test seam: unlink every jar this process created. */
export const resetCookieJars = (): void => {
  contextJarPaths.clear();
  resetBrowserCookieJars();
};

/**
 * Context-owned jars register digest → path here so `X-AIHub-Cookie-Jar` can
 * carry a secret-safe digest instead of a filesystem path or a raw device id.
 * Legacy callers still send a device id; those resolve through {@link getCookieJarPath}.
 */
const contextJarPaths = new Map<string, string>();

export const registerContextCookieJar = (digest: string, path: string): void => {
  contextJarPaths.set(digest, path);
};

export const unregisterContextCookieJar = (digest: string): void => {
  contextJarPaths.delete(digest);
};

/** Absolute paths, registered context digests, or the legacy device-id key. */
export const resolveCookieJarPath = (key: string): string => {
  const registered = contextJarPaths.get(key);
  if (registered) return registered;
  if (key.startsWith('/') || key.includes('/')) return key;
  return getCookieJarPath(key);
};

/** True when `key` names a context jar (do not seed `oai-did` from the key). */
export const isContextCookieJarKey = (key: string): boolean =>
  contextJarPaths.has(key) || key.startsWith('/') || key.includes('/');

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

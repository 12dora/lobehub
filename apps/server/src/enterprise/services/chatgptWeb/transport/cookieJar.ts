import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { COOKIE_JAR_HEADER } from '@lobechat/model-runtime/chatgptWebIdentity';

/**
 * Private hop-by-hop header. Runtime / oauth set this to the connection
 * `deviceId`. This transport strips it before spawning curl and never forwards
 * it upstream. Defined in the runtime (`sessionId.ts`) so both sides agree.
 */
export { COOKIE_JAR_HEADER };

const JAR_DIR_NAME = 'aihub-chatgptweb-jars';
const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
const HTTPONLY_PREFIX = '#HttpOnly_';

/** In-process set of jar files this process created or touched (lost on restart). */
const createdJars = new Set<string>();

export interface CookieSeed {
  domain: string;
  httpOnly?: boolean;
  name: string;
  path?: string;
  secure?: boolean;
  value: string;
}

interface NetscapeCookie {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
}

const jarDirectory = (): string => nodePath.join(tmpdir(), JAR_DIR_NAME);

const hashKey = (connectionKey: string): string =>
  createHash('sha256').update(connectionKey).digest('hex');

/** Deterministic Netscape jar path: `$TMPDIR/aihub-chatgptweb-jars/<sha256(connectionKey)>.txt`. */
export const getCookieJarPath = (connectionKey: string): string =>
  nodePath.join(jarDirectory(), `${hashKey(connectionKey)}.txt`);

const cookieIdentity = (cookie: Pick<NetscapeCookie, 'domain' | 'name' | 'path'>): string =>
  `${cookie.name}\0${cookie.domain.replace(/^\./, '')}\0${cookie.path}`;

const isSafeCookieSeed = (cookie: CookieSeed): boolean => {
  if (!/^[\w.-]{1,128}$/.test(cookie.name)) return false;
  if (!cookie.value || /[\s,;]/.test(cookie.value)) return false;
  if (!/^\.?[\da-z][\da-z.-]*$/i.test(cookie.domain)) return false;
  if (cookie.path && /[\n\r\t]/.test(cookie.path)) return false;
  return true;
};

const formatCookieLine = (cookie: NetscapeCookie): string => {
  const domain = cookie.httpOnly ? `${HTTPONLY_PREFIX}${cookie.domain}` : cookie.domain;
  const tailmatch = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  return `${domain}\t${tailmatch}\t${cookie.path}\t${secure}\t${cookie.expires}\t${cookie.name}\t${cookie.value}`;
};

const parseCookieLine = (line: string): NetscapeCookie | undefined => {
  let httpOnly = false;
  let rest = line;
  if (rest.startsWith(HTTPONLY_PREFIX)) {
    httpOnly = true;
    rest = rest.slice(HTTPONLY_PREFIX.length);
  } else if (rest.startsWith('#') || rest.trim().length === 0) {
    return undefined;
  }
  const parts = rest.split('\t');
  if (parts.length < 7) return undefined;
  const [domain, , path, secure, expires, name, value] = parts;
  if (!domain || !path || !name) return undefined;
  return {
    domain,
    expires: Number.parseInt(expires ?? '0', 10) || 0,
    httpOnly,
    name,
    path,
    secure: secure === 'TRUE',
    value: value ?? '',
  };
};

const readCookies = (path: string): NetscapeCookie[] => {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const cookies: NetscapeCookie[] = [];
  for (const line of text.split('\n')) {
    const cookie = parseCookieLine(line.replace(/\r$/, ''));
    if (cookie) cookies.push(cookie);
  }
  return cookies;
};

const writeCookies = (path: string, cookies: NetscapeCookie[]): void => {
  const body = [NETSCAPE_HEADER, '', ...cookies.map(formatCookieLine), ''].join('\n');
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
};

/**
 * Create the jar file at 0600 inside a 0700 directory when it does not exist.
 * Safe to call on every request; existing files are only chmod'd.
 */
export const ensureCookieJarFile = (path: string): void => {
  const directory = nodePath.dirname(path);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  if (!existsSync(path)) {
    writeFileSync(path, `${NETSCAPE_HEADER}\n\n`, { flag: 'wx', mode: 0o600 });
  }
  chmodSync(path, 0o600);
  createdJars.add(path);
};

/**
 * Write or replace Netscape cookie lines. Existing cookies whose (name, domain, path)
 * do not match a seed are kept — curl's `__cf_bm` / `_cfuvid` survive a re-seed of
 * `oai-did` or the vault session token.
 */
export const seedCookieJar = (path: string, cookies: CookieSeed[]): void => {
  ensureCookieJarFile(path);
  const merged = new Map<string, NetscapeCookie>();
  for (const cookie of readCookies(path)) merged.set(cookieIdentity(cookie), cookie);
  for (const seed of cookies) {
    if (!isSafeCookieSeed(seed)) continue;
    const cookie: NetscapeCookie = {
      domain: seed.domain,
      expires: 0,
      httpOnly: seed.httpOnly === true,
      name: seed.name,
      path: seed.path ?? '/',
      secure: seed.secure !== false,
      value: seed.value,
    };
    merged.set(cookieIdentity(cookie), cookie);
  }
  writeCookies(path, [...merged.values()]);
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
  const path = getCookieJarPath(connectionKey);
  createdJars.delete(path);
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};

/** Test seam: unlink every jar this process created. */
export const resetCookieJars = (): void => {
  for (const path of createdJars) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
  createdJars.clear();
};

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
  deviceId?: string,
): Record<string, string> => (deviceId ? { ...headers, [COOKIE_JAR_HEADER]: deviceId } : headers);

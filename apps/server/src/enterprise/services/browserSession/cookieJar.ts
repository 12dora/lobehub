import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import debug from 'debug';

import { digestBrowserSessionMaterial } from './identity';
import type { BrowserSessionCookieJarRef } from './types';

const log = debug('lobe-server:browser-session');

export const DEFAULT_BROWSER_COOKIE_JAR_DIR_NAME = 'aihub-browser-session-jars';

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
const HTTPONLY_PREFIX = '#HttpOnly_';
const COOKIE_CHUNK_SUFFIX = /\.(\d+)$/;
const COOKIE_NAME = /^[\w.-]{1,128}$/;
const COOKIE_DOMAIN = /^\.?[\da-z][\da-z.-]*$/i;
const MAX_COOKIE_VALUE_LENGTH = 16_384;

/** In-process set of jar files this process created or touched (lost on restart). */
const createdJars = new Set<string>();

export interface CookieSeed {
  domain: string;
  expires?: number;
  httpOnly?: boolean;
  name: string;
  path?: string;
  secure?: boolean;
  value: string;
}

export interface CookieRecord {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
}

/** Value-free view for logs and tests. Never include cookie values here. */
export interface CookieJarInspection {
  cookies: Array<Omit<CookieRecord, 'value'>>;
  count: number;
  pathDigest: string;
}

export interface SeedBrowserCookieJarOptions {
  /**
   * Only these names (or their `.N` chunk family) are written. Extra seeds are
   * dropped — this is the guard against ingesting a full Chrome cookie export.
   */
  allowedNames?: string[];
}

export interface ApplySetCookieOptions {
  allowedNames?: string[];
  defaultDomain: string;
  defaultPath?: string;
  now?: number;
}

export interface ReplaceCookieFamilyParams {
  cookies: CookieSeed[];
  domain: string;
  familyName: string;
  path?: string;
}

const jarDirectory = (directoryName: string): string => nodePath.join(tmpdir(), directoryName);

const pathDigest = (path: string): string => digestBrowserSessionMaterial(path);

export const resolveBrowserCookieJarPath = (params: {
  directoryName?: string;
  key: string;
}): string =>
  nodePath.join(
    jarDirectory(params.directoryName ?? DEFAULT_BROWSER_COOKIE_JAR_DIR_NAME),
    `${digestBrowserSessionMaterial(params.key)}.txt`,
  );

export const cookieFamilyName = (name: string): string => name.replace(COOKIE_CHUNK_SUFFIX, '');

export const isCookieFamilyMember = (name: string, familyName: string): boolean =>
  name === familyName ||
  (name.startsWith(`${familyName}.`) && COOKIE_CHUNK_SUFFIX.test(name.slice(familyName.length)));

export const isAllowedCookieName = (name: string, allowedNames: string[]): boolean =>
  allowedNames.some((allowed) => isCookieFamilyMember(name, allowed));

/**
 * Lowercase only. A leading `.` is load-bearing Netscape identity: host-only
 * (`chatgpt.com`, tailmatch=FALSE) and domain-scoped (`.chatgpt.com`, tailmatch=TRUE)
 * are distinct cookies and can coexist. Stripping the dot would merge/clobber them.
 */
const normalizeDomain = (domain: string): string => domain.toLowerCase();

const cookieIdentity = (cookie: Pick<CookieRecord, 'domain' | 'name' | 'path'>): string =>
  `${cookie.name}\0${normalizeDomain(cookie.domain)}\0${cookie.path}`;

const familyIdentity = (familyName: string, domain: string, path: string): string =>
  `${familyName}\0${normalizeDomain(domain)}\0${path}`;

export const isSafeCookieSeed = (cookie: CookieSeed): boolean => {
  if (!COOKIE_NAME.test(cookie.name)) return false;
  if (!cookie.value || cookie.value.length > MAX_COOKIE_VALUE_LENGTH) return false;
  if (/[\s,;\0]/.test(cookie.value)) return false;
  if (!COOKIE_DOMAIN.test(cookie.domain)) return false;
  if (cookie.path && /[\n\r\t]/.test(cookie.path)) return false;
  return true;
};

const formatCookieLine = (cookie: CookieRecord): string => {
  const domain = cookie.httpOnly ? `${HTTPONLY_PREFIX}${cookie.domain}` : cookie.domain;
  const tailmatch = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  return `${domain}\t${tailmatch}\t${cookie.path}\t${secure}\t${cookie.expires}\t${cookie.name}\t${cookie.value}`;
};

const parseCookieLine = (line: string): CookieRecord | undefined => {
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
  const [domain, , path, secure, expires, name, ...valueParts] = parts;
  if (!domain || !path || !name) return undefined;
  return {
    domain,
    expires: Number.parseInt(expires ?? '0', 10) || 0,
    httpOnly,
    name,
    path,
    secure: secure === 'TRUE',
    value: valueParts.join('\t'),
  };
};

const toCookieRecord = (seed: CookieSeed): CookieRecord => ({
  domain: seed.domain,
  expires: seed.expires ?? 0,
  httpOnly: seed.httpOnly === true,
  name: seed.name,
  path: seed.path ?? '/',
  secure: seed.secure !== false,
  value: seed.value,
});

const writeAtomically = (path: string, body: string): void => {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'EPERM') {
      unlinkSync(path);
      renameSync(tmp, path);
    } else {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup of the staging file.
      }
      throw error;
    }
  }
  chmodSync(path, 0o600);
};

const writeCookies = (path: string, cookies: CookieRecord[]): void => {
  const body = [NETSCAPE_HEADER, '', ...cookies.map(formatCookieLine), ''].join('\n');
  writeAtomically(path, body);
};

export const readBrowserCookieJar = (path: string): CookieRecord[] => {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const cookies: CookieRecord[] = [];
  for (const line of text.split('\n')) {
    const cookie = parseCookieLine(line.replace(/\r$/, ''));
    if (cookie) cookies.push(cookie);
  }
  return cookies;
};

export const inspectBrowserCookieJar = (path: string): CookieJarInspection => {
  const cookies = readBrowserCookieJar(path).map((cookie) => ({
    domain: cookie.domain,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    secure: cookie.secure,
  }));
  return {
    cookies,
    count: cookies.length,
    pathDigest: pathDigest(path),
  };
};

/**
 * Create the jar file at 0600 inside a 0700 directory when it does not exist.
 * Safe to call on every request; existing files are only chmod'd.
 */
export const ensureBrowserCookieJarFile = (path: string): void => {
  const directory = nodePath.dirname(path);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  if (!existsSync(path)) {
    writeFileSync(path, `${NETSCAPE_HEADER}\n\n`, { flag: 'wx', mode: 0o600 });
  }
  chmodSync(path, 0o600);
  createdJars.add(path);
};

export const createBrowserCookieJar = (params: {
  directoryName?: string;
  key: string;
}): BrowserSessionCookieJarRef => {
  const path = resolveBrowserCookieJarPath(params);
  ensureBrowserCookieJarFile(path);
  return {
    digest: digestBrowserSessionMaterial(params.key),
    path,
  };
};

const admitSeeds = (cookies: CookieSeed[], allowedNames?: string[]): CookieSeed[] =>
  cookies.filter((seed) => {
    if (!isSafeCookieSeed(seed)) return false;
    if (allowedNames && !isAllowedCookieName(seed.name, allowedNames)) return false;
    return true;
  });

const mergeReplacingFamilies = (
  existing: CookieRecord[],
  incoming: CookieRecord[],
): CookieRecord[] => {
  const replaced = new Set(
    incoming.map((cookie) =>
      familyIdentity(cookieFamilyName(cookie.name), cookie.domain, cookie.path),
    ),
  );
  const merged = new Map<string, CookieRecord>();
  for (const cookie of existing) {
    if (replaced.has(familyIdentity(cookieFamilyName(cookie.name), cookie.domain, cookie.path))) {
      continue;
    }
    merged.set(cookieIdentity(cookie), cookie);
  }
  for (const cookie of incoming) merged.set(cookieIdentity(cookie), cookie);
  return [...merged.values()];
};

/**
 * Write or replace Netscape cookie lines. Existing cookies whose cookie family
 * (name or `name.N` chunk) is not in the seed are kept — curl's `__cf_bm` /
 * `_cfuvid` survive a re-seed of provider credentials.
 *
 * Seeding any member of a family (base name or `.N` chunk) replaces the whole
 * family so a rotation cannot leave a stale `.1` beside a new unchunked cookie.
 *
 * Only provider-declared cookies should be passed. Use `allowedNames` when the
 * input might contain a full browser export.
 */
export const seedBrowserCookieJar = (
  path: string,
  cookies: CookieSeed[],
  options?: SeedBrowserCookieJarOptions,
): void => {
  ensureBrowserCookieJarFile(path);
  const admitted = admitSeeds(cookies, options?.allowedNames);
  const incoming = admitted.map(toCookieRecord);
  writeCookies(path, mergeReplacingFamilies(readBrowserCookieJar(path), incoming));
  log(
    'seeded jar %s cookies=%d families=%d',
    pathDigest(path),
    incoming.length,
    new Set(incoming.map((cookie) => cookieFamilyName(cookie.name))).size,
  );
};

/** Remove one cookie family (base + `.N` chunks) at domain/path, then write `cookies`. */
export const replaceBrowserCookieFamily = (
  path: string,
  params: ReplaceCookieFamilyParams,
): void => {
  ensureBrowserCookieJarFile(path);
  const cookiePath = params.path ?? '/';
  const admitted = admitSeeds(
    params.cookies.map((cookie) => ({
      ...cookie,
      domain: cookie.domain || params.domain,
      path: cookie.path ?? cookiePath,
    })),
  );
  const existing = readBrowserCookieJar(path).filter(
    (cookie) =>
      !(
        isCookieFamilyMember(cookie.name, params.familyName) &&
        normalizeDomain(cookie.domain) === normalizeDomain(params.domain) &&
        cookie.path === cookiePath
      ),
  );
  writeCookies(path, [...existing, ...admitted.map(toCookieRecord)]);
};

interface ParsedSetCookie {
  deleted: boolean;
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
}

const parseSetCookie = (
  header: string,
  nowMs: number,
  defaults: { domain: string; path: string },
): ParsedSetCookie | undefined => {
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const [head, ...attrParts] = trimmed.split(';');
  if (!head) return undefined;
  const eq = head.indexOf('=');
  if (eq <= 0) return undefined;
  const name = head.slice(0, eq).trim();
  const value = head.slice(eq + 1).trim();
  if (!COOKIE_NAME.test(name)) return undefined;

  let domain = defaults.domain;
  let path = defaults.path;
  let secure = false;
  let httpOnly = false;
  let maxAge: number | undefined;
  let expiresAt: number | undefined;

  for (const raw of attrParts) {
    const part = raw.trim();
    const attrEq = part.indexOf('=');
    const attrName = (attrEq === -1 ? part : part.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq === -1 ? '' : part.slice(attrEq + 1).trim();
    switch (attrName) {
      case 'domain': {
        if (attrValue) domain = attrValue;
        break;
      }
      case 'path': {
        path = attrValue || '/';
        break;
      }
      case 'secure': {
        secure = true;
        break;
      }
      case 'httponly': {
        httpOnly = true;
        break;
      }
      case 'max-age': {
        const parsed = Number.parseInt(attrValue, 10);
        if (Number.isFinite(parsed)) maxAge = parsed;
        break;
      }
      case 'expires': {
        const parsed = Date.parse(attrValue);
        if (Number.isFinite(parsed)) expiresAt = Math.floor(parsed / 1000);
        break;
      }
      default: {
        break;
      }
    }
  }

  let expires = 0;
  if (maxAge !== undefined) {
    expires = maxAge <= 0 ? 1 : Math.floor(nowMs / 1000) + maxAge;
  } else if (expiresAt !== undefined) {
    expires = expiresAt;
  }

  const deleted =
    value.length === 0 ||
    (maxAge !== undefined && maxAge <= 0) ||
    (expires > 0 && expires * 1000 <= nowMs);

  return { deleted, domain, expires, httpOnly, name, path, secure, value };
};

/**
 * Apply `Set-Cookie` headers. A family that receives any live member is replaced
 * as a whole so obsolete `.N` chunks disappear. Deletion-only headers remove
 * just those names.
 */
export const applySetCookieToBrowserCookieJar = (
  path: string,
  headers: string[],
  options: ApplySetCookieOptions,
): void => {
  ensureBrowserCookieJarFile(path);
  const now = options.now ?? Date.now();
  const defaults = { domain: options.defaultDomain, path: options.defaultPath ?? '/' };
  const parsed = headers
    .map((header) => parseSetCookie(header, now, defaults))
    .filter((cookie): cookie is ParsedSetCookie => Boolean(cookie))
    .filter(
      (cookie) => !options.allowedNames || isAllowedCookieName(cookie.name, options.allowedNames),
    );

  if (parsed.length === 0) return;

  const existing = new Map(
    readBrowserCookieJar(path).map((cookie) => [cookieIdentity(cookie), cookie]),
  );
  const byFamily = new Map<string, ParsedSetCookie[]>();
  for (const cookie of parsed) {
    const key = familyIdentity(cookieFamilyName(cookie.name), cookie.domain, cookie.path);
    const list = byFamily.get(key) ?? [];
    list.push(cookie);
    byFamily.set(key, list);
  }

  for (const group of byFamily.values()) {
    const live = group.filter((cookie) => !cookie.deleted);
    if (live.length > 0) {
      const sample = live[0]!;
      for (const [key, cookie] of existing) {
        if (
          isCookieFamilyMember(cookie.name, cookieFamilyName(sample.name)) &&
          normalizeDomain(cookie.domain) === normalizeDomain(sample.domain) &&
          cookie.path === sample.path
        ) {
          existing.delete(key);
        }
      }
      for (const cookie of live) {
        if (!isSafeCookieSeed(cookie)) continue;
        existing.set(cookieIdentity(cookie), {
          domain: cookie.domain,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          name: cookie.name,
          path: cookie.path,
          secure: cookie.secure,
          value: cookie.value,
        });
      }
      continue;
    }

    for (const cookie of group) {
      existing.delete(cookieIdentity(cookie));
    }
  }

  writeCookies(path, [...existing.values()]);
};

export const purgeExpiredBrowserCookies = (path: string, now = Date.now()): void => {
  if (!existsSync(path)) return;
  const kept = readBrowserCookieJar(path).filter(
    (cookie) => cookie.expires === 0 || cookie.expires * 1000 > now,
  );
  writeCookies(path, kept);
};

export const deleteBrowserCookieJar = (path: string): void => {
  createdJars.delete(path);
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};

/** Test / shutdown seam: unlink every jar this process created. */
export const resetBrowserCookieJars = (): void => {
  for (const path of createdJars) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
  createdJars.clear();
};

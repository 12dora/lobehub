import { existsSync } from 'node:fs';

import debug from 'debug';

import type { CookieRecord, CookieSeed, ParsedSetCookie } from './cookieJar.parse';
import {
  cookieFamilyName,
  cookieIdentity,
  familyIdentity,
  isAllowedCookieName,
  isCookieFamilyMember,
  isSafeCookieSeed,
  normalizeDomain,
  parseSetCookie,
  toCookieRecord,
} from './cookieJar.parse';
import {
  ensureBrowserCookieJarFile,
  isJarWritable,
  readBrowserCookieJar,
  withBrowserCookieJarLock,
  writeCookies,
} from './cookieJar.store';
import { digestBrowserSessionMaterial } from './identity';

const log = debug('lobe-server:browser-session');

const pathDigest = (path: string): string => digestBrowserSessionMaterial(path);

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
  withBrowserCookieJarLock(path, () => {
    if (!isJarWritable(path)) return;
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
  });
};

/** Remove one cookie family (base + `.N` chunks) at domain/path, then write `cookies`. */
export const replaceBrowserCookieFamily = (
  path: string,
  params: ReplaceCookieFamilyParams,
): void => {
  withBrowserCookieJarLock(path, () => {
    if (!isJarWritable(path)) return;
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
  });
};

const applyLiveSetCookieFamily = (
  existing: Map<string, CookieRecord>,
  live: ParsedSetCookie[],
): void => {
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
  withBrowserCookieJarLock(path, () => {
    if (!isJarWritable(path)) return;
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
        applyLiveSetCookieFamily(existing, live);
        continue;
      }

      for (const cookie of group) {
        existing.delete(cookieIdentity(cookie));
      }
    }

    writeCookies(path, [...existing.values()]);
  });
};

export const purgeExpiredBrowserCookies = (path: string, now = Date.now()): void => {
  if (!existsSync(path)) return;
  const kept = readBrowserCookieJar(path).filter(
    (cookie) => cookie.expires === 0 || cookie.expires * 1000 > now,
  );
  writeCookies(path, kept);
};

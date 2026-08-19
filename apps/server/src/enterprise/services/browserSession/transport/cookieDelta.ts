/**
 * Merge one easy handle's COOKIELIST into the on-disk Netscape jar.
 *
 * We never set CURLOPT_COOKIEJAR: each handle would rewrite the whole file at
 * cleanup and the last writer would clobber parallel Set-Cookie updates.
 * Instead we snapshot the file at request start, read CURLINFO_COOKIELIST at
 * completion, and apply only the delta under the shared per-path jar lock.
 *
 * Compare-and-swap is family-granular: `(familyName, domain, path)` where
 * `familyName` is the cookie name with an optional `.N` chunk suffix stripped.
 * If the current family's membership or values differ from the snapshot
 * (an external writer changed topology or values), every response change for
 * that family is suppressed. Otherwise the family's final members replace the
 * current members atomically (upserts + deletions).
 */
import type { CookieRecord } from '../cookieJar';
import {
  cookieFamilyName,
  isBrowserCookieJarTombstoned,
  parseNetscapeCookieJarText,
  readBrowserCookieJar,
  withBrowserCookieJarLock,
  writeBrowserCookieJarRecords,
} from '../cookieJar';

const cookieId = (cookie: Pick<CookieRecord, 'domain' | 'name' | 'path'>): string =>
  `${cookie.name}\0${cookie.domain.toLowerCase()}\0${cookie.path}`;

const familyKey = (cookie: Pick<CookieRecord, 'domain' | 'name' | 'path'>): string =>
  `${cookieFamilyName(cookie.name)}\0${cookie.domain.toLowerCase()}\0${cookie.path}`;

const sameCookie = (left: CookieRecord, right: CookieRecord): boolean =>
  left.value === right.value &&
  left.expires === right.expires &&
  left.httpOnly === right.httpOnly &&
  left.secure === right.secure;

const groupByFamily = (cookies: CookieRecord[]): Map<string, CookieRecord[]> => {
  const groups = new Map<string, CookieRecord[]>();
  for (const cookie of cookies) {
    const key = familyKey(cookie);
    const members = groups.get(key);
    if (members) members.push(cookie);
    else groups.set(key, [cookie]);
  }
  return groups;
};

const familyEquals = (left: CookieRecord[], right: CookieRecord[]): boolean => {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((cookie) => [cookieId(cookie), cookie]));
  for (const cookie of left) {
    const other = rightById.get(cookieId(cookie));
    if (!other || !sameCookie(cookie, other)) return false;
  }
  return true;
};

export const applyCookieListDelta = (params: {
  cookieJarPath: string;
  listLines: string[];
  snapshot: CookieRecord[];
}): void => {
  const { cookieJarPath, listLines, snapshot } = params;
  if (!cookieJarPath || isBrowserCookieJarTombstoned(cookieJarPath)) return;

  withBrowserCookieJarLock(cookieJarPath, () => {
    if (isBrowserCookieJarTombstoned(cookieJarPath)) return;
    const snapshotFamilies = groupByFamily(snapshot);
    const finalFamilies = groupByFamily(parseNetscapeCookieJarText(listLines.join('\n')));
    const currentCookies = readBrowserCookieJar(cookieJarPath);
    const currentFamilies = groupByFamily(currentCookies);
    const managedKeys = new Set([...snapshotFamilies.keys(), ...finalFamilies.keys()]);

    const next: CookieRecord[] = [];
    for (const cookie of currentCookies) {
      if (!managedKeys.has(familyKey(cookie))) next.push(cookie);
    }

    for (const key of managedKeys) {
      const snap = snapshotFamilies.get(key) ?? [];
      const cur = currentFamilies.get(key) ?? [];
      if (!familyEquals(cur, snap)) {
        next.push(...cur);
        continue;
      }
      next.push(...(finalFamilies.get(key) ?? []));
    }

    writeBrowserCookieJarRecords(cookieJarPath, next);
  });
};

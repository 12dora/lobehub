/**
 * Merge one easy handle's COOKIELIST into the on-disk Netscape jar.
 *
 * We never set CURLOPT_COOKIEJAR: each handle would rewrite the whole file at
 * cleanup and the last writer would clobber parallel Set-Cookie updates.
 * Instead we snapshot the file at request start, read CURLINFO_COOKIELIST at
 * completion, and apply only the delta under the shared per-path jar lock.
 *
 * Compare-and-swap vs the snapshot:
 * - delete/update only while the current jar value still equals the snapshot
 *   (external change or deletion wins);
 * - a cookie absent from the snapshot is upserted only if current is missing
 *   or already equal; a different current value is treated as an external write.
 */
import type { CookieRecord } from '../cookieJar';
import {
  isBrowserCookieJarTombstoned,
  parseNetscapeCookieJarText,
  readBrowserCookieJar,
  withBrowserCookieJarLock,
  writeBrowserCookieJarRecords,
} from '../cookieJar';

const cookieId = (cookie: Pick<CookieRecord, 'domain' | 'name' | 'path'>): string =>
  `${cookie.name}\0${cookie.domain.toLowerCase()}\0${cookie.path}`;

const sameCookie = (left: CookieRecord, right: CookieRecord): boolean =>
  left.value === right.value &&
  left.expires === right.expires &&
  left.httpOnly === right.httpOnly &&
  left.secure === right.secure;

export const applyCookieListDelta = (params: {
  cookieJarPath: string;
  listLines: string[];
  snapshot: CookieRecord[];
}): void => {
  const { cookieJarPath, listLines, snapshot } = params;
  if (!cookieJarPath || isBrowserCookieJarTombstoned(cookieJarPath)) return;

  withBrowserCookieJarLock(cookieJarPath, () => {
    if (isBrowserCookieJarTombstoned(cookieJarPath)) return;
    const snapshotMap = new Map(snapshot.map((cookie) => [cookieId(cookie), cookie]));
    const finalMap = new Map(
      parseNetscapeCookieJarText(listLines.join('\n')).map((cookie) => [cookieId(cookie), cookie]),
    );
    const current = new Map(
      readBrowserCookieJar(cookieJarPath).map((cookie) => [cookieId(cookie), cookie]),
    );

    for (const [id, snap] of snapshotMap) {
      if (finalMap.has(id)) continue;
      const cur = current.get(id);
      if (cur && sameCookie(cur, snap)) current.delete(id);
    }

    for (const [id, cookie] of finalMap) {
      const snap = snapshotMap.get(id);
      const cur = current.get(id);
      if (snap) {
        if (sameCookie(snap, cookie)) continue;
        if (cur && sameCookie(cur, snap)) current.set(id, cookie);
        continue;
      }
      if (!cur) current.set(id, cookie);
    }

    writeBrowserCookieJarRecords(cookieJarPath, [...current.values()]);
  });
};

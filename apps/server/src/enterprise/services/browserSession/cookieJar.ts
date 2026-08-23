import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import type { CookieRecord } from './cookieJar.parse';
import {
  clearAllCookieJarTracking,
  createdJars,
  dropTombstoneForPath,
  ensureBrowserCookieJarFile,
  readBrowserCookieJar,
  tombstoneBrowserCookieJar,
} from './cookieJar.store';
import { digestBrowserSessionMaterial } from './identity';
import type { BrowserSessionCookieJarRef } from './types';

export const DEFAULT_BROWSER_COOKIE_JAR_DIR_NAME = 'aihub-browser-session-jars';
/**
 * Pre-C1 ChatGPT device-id jar directory. Swept at boot so a crash cannot
 * reopen a partial old jar beside a new page id. The common layer does not
 * import ChatGPT modules — this is a well-known on-disk location.
 */
export const LEGACY_DEVICE_BROWSER_COOKIE_JAR_DIR_NAME = 'aihub-chatgptweb-jars';

export type {
  ApplySetCookieOptions,
  ReplaceCookieFamilyParams,
  SeedBrowserCookieJarOptions,
} from './cookieJar.mutate';
export {
  applySetCookieToBrowserCookieJar,
  purgeExpiredBrowserCookies,
  replaceBrowserCookieFamily,
  seedBrowserCookieJar,
} from './cookieJar.mutate';
export type { CookieRecord, CookieSeed } from './cookieJar.parse';
export {
  cookieFamilyName,
  isAllowedCookieName,
  isCookieFamilyMember,
  isSafeCookieSeed,
  parseNetscapeCookieJarText,
} from './cookieJar.parse';
export {
  clearBrowserCookieJarTombstone,
  ensureBrowserCookieJarFile,
  isBrowserCookieJarTombstoned,
  readBrowserCookieJar,
  tombstoneBrowserCookieJar,
  withBrowserCookieJarLock,
  writeBrowserCookieJarRecords,
} from './cookieJar.store';

/** Value-free view for logs and tests. Never include cookie values here. */
export interface CookieJarInspection {
  cookies: Array<Omit<CookieRecord, 'value'>>;
  count: number;
  pathDigest: string;
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

export const createBrowserCookieJar = (params: {
  directoryName?: string;
  key: string;
}): BrowserSessionCookieJarRef => {
  const path = resolveBrowserCookieJarPath(params);
  // A new contextId produces a new path; drop any stale tombstone for that
  // path only so a UUID collision (astronomically rare) is still writable.
  dropTombstoneForPath(path);
  ensureBrowserCookieJarFile(path);
  return {
    digest: digestBrowserSessionMaterial(params.key),
    path,
  };
};

export const deleteBrowserCookieJar = (path: string): void => {
  tombstoneBrowserCookieJar(path);
  createdJars.delete(path);
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};

const unlinkQuietly = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};

const sweepJarDirectory = (
  directoryName: string,
  shouldUnlink: (fileName: string) => boolean,
): void => {
  const directory = jarDirectory(directoryName);
  if (!existsSync(directory)) return;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!shouldUnlink(name)) continue;
    if (!name.endsWith('.txt') && !name.endsWith('.tmp')) continue;
    const path = nodePath.join(directory, name);
    createdJars.delete(path);
    unlinkQuietly(path);
  }
};

/**
 * Boot-time orphan wipe. Process-local registry maps die with the process;
 * leftover disk jars would otherwise leak (context UUID paths) or be reopened
 * as a partial identity (legacy device-id paths).
 *
 * Single-process assumption: do not run this if two OS processes share
 * `$TMPDIR` — it would unlink the other process's live jars (plan principle 7).
 *
 * `pending-wipe-*` files are admin disconnect recovery, not cookie jars.
 */
export const sweepOrphanBrowserCookieJars = (): void => {
  sweepJarDirectory(DEFAULT_BROWSER_COOKIE_JAR_DIR_NAME, () => true);
  sweepJarDirectory(
    LEGACY_DEVICE_BROWSER_COOKIE_JAR_DIR_NAME,
    (fileName) => !fileName.startsWith('pending-wipe-'),
  );
};

/** Paths this process currently tracks as created jars. */
export const snapshotCreatedBrowserCookieJars = (): string[] => [...createdJars];

/**
 * Drop tracking for `paths` without unlinking. Used when reset cleanup is
 * unproven so a later successful reset cannot delete a replacement's jars.
 */
export const forgetCreatedBrowserCookieJars = (paths: readonly string[]): void => {
  for (const path of paths) createdJars.delete(path);
};

/** Test / shutdown seam: unlink every jar this process created. */
export const resetBrowserCookieJars = (): void => {
  for (const path of createdJars) unlinkQuietly(path);
  clearAllCookieJarTracking();
};

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
import nodePath from 'node:path';

import type { CookieRecord } from './cookieJar.parse';
import { formatCookieLine, NETSCAPE_HEADER, parseNetscapeCookieJarText } from './cookieJar.parse';

/** In-process set of jar files this process created or touched (lost on restart). */
export const createdJars = new Set<string>();
/**
 * Paths that must not be recreated. Survives unlink so a late curl `--cookie-jar`
 * or `ensureBrowserCookieJarFile` cannot resurrect a dropped context's jar.
 * Bounded LRU: tombstones are retained after drain (not cleared). Retired
 * context keys fence stale traffic. Cap is a backstop for leaked entries.
 */
const TOMBSTONE_CAP = 4096;
const tombstonedJars = new Set<string>();
const tombstoneOrder: string[] = [];

export const isBrowserCookieJarTombstoned = (path: string): boolean => tombstonedJars.has(path);

export const tombstoneBrowserCookieJar = (path: string): void => {
  if (tombstonedJars.has(path)) return;
  tombstonedJars.add(path);
  tombstoneOrder.push(path);
  while (tombstoneOrder.length > TOMBSTONE_CAP) {
    const oldest = tombstoneOrder.shift();
    if (oldest) tombstonedJars.delete(oldest);
  }
};

/** Drop the fence after drains settled. Boot-swept orphans never need this. */
export const clearBrowserCookieJarTombstone = (path: string): void => {
  if (!tombstonedJars.delete(path)) return;
  const index = tombstoneOrder.indexOf(path);
  if (index >= 0) tombstoneOrder.splice(index, 1);
};

export const isJarWritable = (path: string): boolean => !tombstonedJars.has(path);

export const dropTombstoneForPath = (path: string): void => {
  tombstonedJars.delete(path);
};

export const clearAllCookieJarTracking = (): void => {
  createdJars.clear();
  tombstonedJars.clear();
  tombstoneOrder.length = 0;
};

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

export const writeCookies = (path: string, cookies: CookieRecord[]): void => {
  const body = [NETSCAPE_HEADER, '', ...cookies.map(formatCookieLine), ''].join('\n');
  writeAtomically(path, body);
};

/**
 * In-process per-path mutex for read-modify-write jar updates.
 *
 * Synchronous. Same-stack reentry is allowed so a locked writer may call
 * {@link writeBrowserCookieJarRecords}. Distinct callers cannot interleave
 * in JS; this serializes RMW sections that must not race a COOKIELIST delta.
 */
const jarLockDepth = new Map<string, number>();

export const withBrowserCookieJarLock = <T>(path: string, fn: () => T): T => {
  jarLockDepth.set(path, (jarLockDepth.get(path) ?? 0) + 1);
  try {
    return fn();
  } finally {
    const depth = (jarLockDepth.get(path) ?? 1) - 1;
    if (depth <= 0) jarLockDepth.delete(path);
    else jarLockDepth.set(path, depth);
  }
};

export const readBrowserCookieJar = (path: string): CookieRecord[] => {
  if (!existsSync(path)) return [];
  return parseNetscapeCookieJarText(readFileSync(path, 'utf8'));
};

/** Atomic replace of the jar contents. No-op when the path is tombstoned. */
export const writeBrowserCookieJarRecords = (path: string, cookies: CookieRecord[]): void =>
  withBrowserCookieJarLock(path, () => {
    if (!isJarWritable(path)) return;
    writeCookies(path, cookies);
  });

/**
 * Create the jar file at 0600 inside a 0700 directory when it does not exist.
 * Safe to call on every request; existing files are only chmod'd.
 */
export const ensureBrowserCookieJarFile = (path: string): void => {
  if (!isJarWritable(path)) return;
  const directory = nodePath.dirname(path);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  if (!existsSync(path)) {
    writeFileSync(path, `${NETSCAPE_HEADER}\n\n`, { flag: 'wx', mode: 0o600 });
  }
  chmodSync(path, 0o600);
  createdJars.add(path);
};

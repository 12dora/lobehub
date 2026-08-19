import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureBrowserCookieJarFile,
  readBrowserCookieJar,
  replaceBrowserCookieFamily,
  resetBrowserCookieJars,
  seedBrowserCookieJar,
} from '../cookieJar';
import { applyCookieListDelta } from './cookieDelta';
import type { LibcurlBindings } from './libcurlFfi';
import { probeLibcurlImpersonate, readCookieSlist } from './libcurlFfi';

const probe = probeLibcurlImpersonate();

const netscapeLine = (name: string, value: string): string =>
  `localhost\tFALSE\t/\tFALSE\t0\t${name}\t${value}`;

describe('applyCookieListDelta compare-and-swap', () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetBrowserCookieJars();
    for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
  });

  const jar = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'c3-cas-'));
    dirs.push(dir);
    const file = path.join(dir, 'jar.txt');
    ensureBrowserCookieJarFile(file);
    return file;
  };

  it('does not overwrite an external family replacement of the same identity', () => {
    const file = jar();
    seedBrowserCookieJar(file, [{ domain: 'localhost', name: 'token', value: 'old' }]);
    const snapshot = readBrowserCookieJar(file);
    replaceBrowserCookieFamily(file, {
      cookies: [{ domain: 'localhost', name: 'token', value: 'external' }],
      domain: 'localhost',
      familyName: 'token',
    });
    applyCookieListDelta({
      cookieJarPath: file,
      listLines: [netscapeLine('token', 'from-server')],
      snapshot,
    });
    expect(readBrowserCookieJar(file).find((cookie) => cookie.name === 'token')?.value).toBe(
      'external',
    );
  });

  it('does not resurrect a cookie after an external family delete', () => {
    const file = jar();
    seedBrowserCookieJar(file, [{ domain: 'localhost', name: 'token', value: 'old' }]);
    const snapshot = readBrowserCookieJar(file);
    replaceBrowserCookieFamily(file, { cookies: [], domain: 'localhost', familyName: 'token' });
    applyCookieListDelta({
      cookieJarPath: file,
      listLines: [netscapeLine('token', 'from-server')],
      snapshot,
    });
    expect(readBrowserCookieJar(file).some((cookie) => cookie.name === 'token')).toBe(false);
  });
});

describe.skipIf(!probe.available)('readCookieSlist', () => {
  it('returns a discriminated failure on non-zero getinfo and does not invent an empty list', () => {
    const bindings = {
      curl_easy_getinfo: () => 77,
      curl_slist_free_all: () => undefined,
    } as unknown as LibcurlBindings;
    expect(readCookieSlist(bindings, {})).toEqual({ code: 77, ok: false });
  });
});

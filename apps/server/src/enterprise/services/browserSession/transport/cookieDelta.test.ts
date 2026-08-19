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
import type { CookieSlistKoffi, LibcurlBindings } from './libcurlFfi';
import { readCookieSlist } from './libcurlFfi';

const netscapeLine = (name: string, value: string): string =>
  `localhost\tFALSE\t/\tFALSE\t0\t${name}\t${value}`;

const namesAndValues = (file: string): Array<[string, string]> =>
  readBrowserCookieJar(file)
    .map((cookie) => [cookie.name, cookie.value] as [string, string])
    .toSorted((left, right) => left[0].localeCompare(right[0]));

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

  it('does not insert response chunks beside an external unchunked family', () => {
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
      listLines: [netscapeLine('token.0', 'chunk-a'), netscapeLine('token.1', 'chunk-b')],
      snapshot,
    });
    expect(namesAndValues(file)).toEqual([['token', 'external']]);
  });

  it('does not collapse external chunks when the response yields an unchunked member', () => {
    const file = jar();
    seedBrowserCookieJar(file, [{ domain: 'localhost', name: 'token', value: 'old' }]);
    const snapshot = readBrowserCookieJar(file);
    replaceBrowserCookieFamily(file, {
      cookies: [
        { domain: 'localhost', name: 'token.0', value: 'ext-a' },
        { domain: 'localhost', name: 'token.1', value: 'ext-b' },
      ],
      domain: 'localhost',
      familyName: 'token',
    });
    applyCookieListDelta({
      cookieJarPath: file,
      listLines: [netscapeLine('token', 'from-server')],
      snapshot,
    });
    expect(namesAndValues(file)).toEqual([
      ['token.0', 'ext-a'],
      ['token.1', 'ext-b'],
    ]);
  });

  it('applies an untouched family while suppressing a contended family', () => {
    const file = jar();
    seedBrowserCookieJar(file, [
      { domain: 'localhost', name: 'token', value: 'old' },
      { domain: 'localhost', name: 'sid', value: 'one' },
    ]);
    const snapshot = readBrowserCookieJar(file);
    replaceBrowserCookieFamily(file, {
      cookies: [{ domain: 'localhost', name: 'token', value: 'external' }],
      domain: 'localhost',
      familyName: 'token',
    });
    applyCookieListDelta({
      cookieJarPath: file,
      listLines: [
        netscapeLine('token.0', 'chunk-a'),
        netscapeLine('token.1', 'chunk-b'),
        netscapeLine('sid', 'two'),
      ],
      snapshot,
    });
    expect(namesAndValues(file)).toEqual([
      ['sid', 'two'],
      ['token', 'external'],
    ]);
  });

  it('applies a matching family topology change atomically', () => {
    const file = jar();
    seedBrowserCookieJar(file, [{ domain: 'localhost', name: 'token', value: 'old' }]);
    const snapshot = readBrowserCookieJar(file);
    applyCookieListDelta({
      cookieJarPath: file,
      listLines: [netscapeLine('token.0', 'chunk-a'), netscapeLine('token.1', 'chunk-b')],
      snapshot,
    });
    expect(namesAndValues(file)).toEqual([
      ['token.0', 'chunk-a'],
      ['token.1', 'chunk-b'],
    ]);
  });
});

describe('readCookieSlist', () => {
  it('returns a discriminated failure on non-zero getinfo and does not invent an empty list', () => {
    const koffi: CookieSlistKoffi = {
      alloc: () => ({}),
      decode: () => {
        throw new Error('decode must not run after getinfo failure');
      },
      struct: () => {
        throw new Error('struct must not run after getinfo failure');
      },
    };
    const bindings = {
      curl_easy_getinfo: () => 77,
      curl_slist_free_all: () => {
        throw new Error('slist free must not run after getinfo failure');
      },
    } as unknown as LibcurlBindings;
    expect(readCookieSlist(bindings, {}, koffi)).toEqual({ code: 77, ok: false });
  });
});

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  COOKIE_JAR_HEADER,
  deleteCookieJar,
  getCookieJarPath,
  resetCookieJars,
  seedCookieJar,
  stripCookieJarHeader,
} from './cookieJar';

afterEach(() => {
  resetCookieJars();
});

describe('getCookieJarPath', () => {
  it('is deterministic under $TMPDIR/aihub-chatgptweb-jars/<sha256(key)>.txt', () => {
    const key = 'device-alpha';
    const digest = createHash('sha256').update(key).digest('hex');
    const path = getCookieJarPath(key);

    expect(path).toBe(nodePath.join(tmpdir(), 'aihub-chatgptweb-jars', `${digest}.txt`));
    expect(getCookieJarPath(key)).toBe(path);
    expect(getCookieJarPath('device-beta')).not.toBe(path);
  });
});

describe('seedCookieJar', () => {
  it('creates a 0600 file inside a 0700 directory and writes Netscape lines', () => {
    const path = getCookieJarPath('seed-device');
    seedCookieJar(path, [{ domain: '.chatgpt.com', name: 'oai-did', value: 'seed-device' }]);

    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(nodePath.dirname(path)).mode & 0o777).toBe(0o700);

    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('# Netscape HTTP Cookie File')).toBe(true);
    expect(text).toContain('oai-did\tseed-device');
    expect(text).toContain('.chatgpt.com');
  });

  it('merges: updates a matching cookie and keeps the others', () => {
    const path = getCookieJarPath('merge-device');
    seedCookieJar(path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'first' },
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-1' },
    ]);
    seedCookieJar(path, [{ domain: '.chatgpt.com', name: 'oai-did', value: 'second' }]);

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('oai-did\tsecond');
    expect(text).not.toContain('oai-did\tfirst');
    expect(text).toContain('_cfuvid\tcf-1');
  });
});

describe('deleteCookieJar / resetCookieJars', () => {
  it('unlinks the jar for a connection key', () => {
    const key = 'delete-me';
    const path = getCookieJarPath(key);
    seedCookieJar(path, [{ domain: '.chatgpt.com', name: 'oai-did', value: key }]);
    expect(existsSync(path)).toBe(true);

    deleteCookieJar(key);
    expect(existsSync(path)).toBe(false);
  });

  it('resetCookieJars unlinks every jar this process created', () => {
    const path = getCookieJarPath('reset-me');
    seedCookieJar(path, [{ domain: '.chatgpt.com', name: 'oai-did', value: 'reset-me' }]);
    expect(existsSync(path)).toBe(true);
    resetCookieJars();
    expect(existsSync(path)).toBe(false);
  });
});

describe('stripCookieJarHeader', () => {
  it('removes the private header and returns its value', () => {
    const { cookieJarKey, headers } = stripCookieJarHeader([
      ['Accept', '*/*'],
      [COOKIE_JAR_HEADER, 'device-1'],
      ['OAI-Device-Id', 'device-1'],
    ]);

    expect(cookieJarKey).toBe('device-1');
    expect(headers).toEqual([
      ['Accept', '*/*'],
      ['OAI-Device-Id', 'device-1'],
    ]);
  });

  it('matches the header case-insensitively and drops empties', () => {
    expect(
      stripCookieJarHeader([
        ['accept', '*/*'],
        ['x-aihub-cookie-jar', ''],
      ]),
    ).toEqual({ headers: [['accept', '*/*']] });
  });
});

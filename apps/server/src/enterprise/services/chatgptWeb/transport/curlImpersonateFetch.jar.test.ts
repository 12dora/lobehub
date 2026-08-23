import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetBrowserCookieJars, tombstoneBrowserCookieJar } from '../../browserSession/cookieJar';
import { CONTEXT_GONE_ERROR, registerContextCookieJar, resetCookieJars } from './cookieJar';
import { resolveCliCookieJarPath } from './curlImpersonateFetch.jar';

afterEach(async () => {
  await Promise.resolve(resetCookieJars());
  resetBrowserCookieJars();
});

describe('resolveCliCookieJarPath', () => {
  it('throws when a registered context jar is tombstoned', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-jar-'));
    const jarPath = path.join(dir, 'gone.txt');
    const digest = `ctx:${'ab'.repeat(32)}`;
    registerContextCookieJar(digest, jarPath, 'pool-gone');
    tombstoneBrowserCookieJar(jarPath);

    expect(() => resolveCliCookieJarPath(digest, undefined)).toThrow(CONTEXT_GONE_ERROR);
  });

  it('clears a tombstoned factory jar when no per-request key is present', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-jar-'));
    const jarPath = path.join(dir, 'factory.txt');
    tombstoneBrowserCookieJar(jarPath);
    expect(resolveCliCookieJarPath(undefined, jarPath)).toBeUndefined();
  });

  it('keeps a factory jar when it is writable and no per-request key is present', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-jar-'));
    const jarPath = path.join(dir, 'factory.txt');
    expect(resolveCliCookieJarPath(undefined, jarPath)).toBe(jarPath);
  });
});

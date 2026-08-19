import { existsSync, readFileSync, statSync } from 'node:fs';
import nodePath from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applySetCookieToBrowserCookieJar,
  cookieFamilyName,
  createBrowserCookieJar,
  deleteBrowserCookieJar,
  ensureBrowserCookieJarFile,
  inspectBrowserCookieJar,
  isBrowserCookieJarTombstoned,
  isCookieFamilyMember,
  purgeExpiredBrowserCookies,
  readBrowserCookieJar,
  replaceBrowserCookieFamily,
  resetBrowserCookieJars,
  resolveBrowserCookieJarPath,
  seedBrowserCookieJar,
} from './cookieJar';

afterEach(() => {
  resetBrowserCookieJars();
});

const jarFor = (key: string) => createBrowserCookieJar({ key });

const names = (path: string) =>
  readBrowserCookieJar(path)
    .map((cookie) => cookie.name)
    .sort();

const valueOf = (path: string, name: string) =>
  readBrowserCookieJar(path).find((cookie) => cookie.name === name)?.value;

describe('cookieFamilyName', () => {
  it('treats only a numeric suffix as a chunk', () => {
    expect(cookieFamilyName('__Secure-next-auth.session-token.0')).toBe(
      '__Secure-next-auth.session-token',
    );
    expect(cookieFamilyName('__Secure-next-auth.session-token')).toBe(
      '__Secure-next-auth.session-token',
    );
    expect(cookieFamilyName('session-token.12')).toBe('session-token');
    expect(isCookieFamilyMember('foo.bar', 'foo')).toBe(false);
    expect(isCookieFamilyMember('foo.0', 'foo')).toBe(true);
  });
});

describe('createBrowserCookieJar / seedBrowserCookieJar', () => {
  it('creates a 0600 file inside a 0700 directory', () => {
    const jar = jarFor('perm-device');
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'perm-device' },
    ]);

    expect(existsSync(jar.path)).toBe(true);
    expect(statSync(jar.path).mode & 0o777).toBe(0o600);
    expect(statSync(nodePath.dirname(jar.path)).mode & 0o777).toBe(0o700);
    expect(jar.path).toBe(resolveBrowserCookieJarPath({ key: 'perm-device' }));
  });

  it('round-trips .0/.1 session chunks through Netscape read/write', () => {
    const jar = jarFor('chunk-roundtrip');
    seedBrowserCookieJar(jar.path, [
      {
        domain: '.chatgpt.com',
        httpOnly: true,
        name: '__Secure-next-auth.session-token.0',
        value: 'chunk-zero-aaaaaaaa',
      },
      {
        domain: '.chatgpt.com',
        httpOnly: true,
        name: '__Secure-next-auth.session-token.1',
        value: 'chunk-one-bbbbbbbb',
      },
    ]);

    const text = readFileSync(jar.path, 'utf8');
    expect(text).toContain('__Secure-next-auth.session-token.0\tchunk-zero-aaaaaaaa');
    expect(text).toContain('__Secure-next-auth.session-token.1\tchunk-one-bbbbbbbb');

    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'same-device' },
    ]);

    expect(valueOf(jar.path, '__Secure-next-auth.session-token.0')).toBe('chunk-zero-aaaaaaaa');
    expect(valueOf(jar.path, '__Secure-next-auth.session-token.1')).toBe('chunk-one-bbbbbbbb');
  });

  it('removes obsolete chunks when a family rotates to an unchunked cookie', () => {
    const jar = jarFor('chunk-rotate');
    seedBrowserCookieJar(jar.path, [
      {
        domain: '.chatgpt.com',
        httpOnly: true,
        name: '__Secure-next-auth.session-token.0',
        value: 'old-0',
      },
      {
        domain: '.chatgpt.com',
        httpOnly: true,
        name: '__Secure-next-auth.session-token.1',
        value: 'old-1',
      },
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-keep' },
    ]);

    seedBrowserCookieJar(jar.path, [
      {
        domain: '.chatgpt.com',
        httpOnly: true,
        name: '__Secure-next-auth.session-token',
        value: 'rotated-plain',
      },
    ]);

    expect(names(jar.path)).toEqual(['__Secure-next-auth.session-token', '_cfuvid']);
    expect(valueOf(jar.path, '__Secure-next-auth.session-token')).toBe('rotated-plain');
    expect(valueOf(jar.path, '_cfuvid')).toBe('cf-keep');
  });

  it('drops a leftover higher chunk when rotation writes fewer chunks', () => {
    const jar = jarFor('chunk-shrink');
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'session-token.0', value: 'a0' },
      { domain: '.chatgpt.com', name: 'session-token.1', value: 'a1' },
      { domain: '.chatgpt.com', name: 'session-token.2', value: 'a2' },
    ]);
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'session-token.0', value: 'b0' },
      { domain: '.chatgpt.com', name: 'session-token.1', value: 'b1' },
    ]);

    expect(names(jar.path)).toEqual(['session-token.0', 'session-token.1']);
    expect(valueOf(jar.path, 'session-token.0')).toBe('b0');
  });

  it('keeps response-written CF cookies when reseeding oai-did', () => {
    const jar = jarFor('cf-survive');
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'first-device' },
      { domain: '.chatgpt.com', name: '__cf_bm', value: 'cf-bm-1' },
      { domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-vid-1' },
    ]);
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'second-device' },
    ]);

    expect(valueOf(jar.path, 'oai-did')).toBe('second-device');
    expect(valueOf(jar.path, '__cf_bm')).toBe('cf-bm-1');
    expect(valueOf(jar.path, '_cfuvid')).toBe('cf-vid-1');
  });

  it('does not ingest undeclared cookies when an allowlist is set', () => {
    const jar = jarFor('allowlist');
    seedBrowserCookieJar(
      jar.path,
      [
        { domain: '.chatgpt.com', name: 'oai-did', value: 'device-1' },
        { domain: '.chatgpt.com', name: 'intercom-session', value: 'should-not-land' },
        { domain: '.chatgpt.com', name: '__Secure-next-auth.session-token.0', value: 'chunk-0' },
      ],
      { allowedNames: ['oai-did', '__Secure-next-auth.session-token'] },
    );

    expect(names(jar.path)).toEqual(['__Secure-next-auth.session-token.0', 'oai-did']);
    expect(valueOf(jar.path, 'intercom-session')).toBeUndefined();
  });

  it('cannot read another jar path from a sibling context key', () => {
    const alpha = jarFor('account-alpha');
    const beta = jarFor('account-beta');
    seedBrowserCookieJar(alpha.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'alpha-secret-device' },
    ]);
    seedBrowserCookieJar(beta.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'beta-secret-device' },
    ]);

    expect(alpha.path).not.toBe(beta.path);
    expect(valueOf(alpha.path, 'oai-did')).toBe('alpha-secret-device');
    expect(valueOf(beta.path, 'oai-did')).toBe('beta-secret-device');
    expect(readFileSync(alpha.path, 'utf8')).not.toContain('beta-secret-device');
    expect(readFileSync(beta.path, 'utf8')).not.toContain('alpha-secret-device');
  });

  it('keeps a host-only cookie distinct from a domain cookie of the same name', () => {
    const jar = jarFor('host-vs-domain');
    seedBrowserCookieJar(jar.path, [
      { domain: 'chatgpt.com', name: 'oai-did', value: 'host-only' },
      { domain: '.chatgpt.com', name: 'oai-did', value: 'domain-scoped' },
    ]);

    const cookies = readBrowserCookieJar(jar.path).filter((cookie) => cookie.name === 'oai-did');
    expect(cookies).toHaveLength(2);
    expect(cookies.map((cookie) => cookie.domain).sort()).toEqual(['.chatgpt.com', 'chatgpt.com']);
    expect(cookies.find((cookie) => cookie.domain === 'chatgpt.com')?.value).toBe('host-only');
    expect(cookies.find((cookie) => cookie.domain === '.chatgpt.com')?.value).toBe('domain-scoped');

    seedBrowserCookieJar(jar.path, [
      { domain: 'chatgpt.com', name: 'oai-did', value: 'host-only-replaced' },
    ]);

    const after = readBrowserCookieJar(jar.path).filter((cookie) => cookie.name === 'oai-did');
    expect(after).toHaveLength(2);
    expect(after.find((cookie) => cookie.domain === 'chatgpt.com')?.value).toBe(
      'host-only-replaced',
    );
    expect(after.find((cookie) => cookie.domain === '.chatgpt.com')?.value).toBe('domain-scoped');
  });

  it('inspects without exposing cookie values', () => {
    const jar = jarFor('inspect');
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'super-secret-value' },
    ]);

    const inspection = inspectBrowserCookieJar(jar.path);
    expect(inspection.count).toBe(1);
    expect(inspection.cookies[0]?.name).toBe('oai-did');
    expect(JSON.stringify(inspection)).not.toContain('super-secret-value');
  });
});

describe('replaceBrowserCookieFamily', () => {
  it('removes a family when replacement cookies are empty', () => {
    const jar = jarFor('replace-empty');
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'session-token.0', value: 'z0' },
      { domain: '.chatgpt.com', name: 'session-token.1', value: 'z1' },
      { domain: '.chatgpt.com', name: 'oai-did', value: 'keep' },
    ]);
    replaceBrowserCookieFamily(jar.path, {
      cookies: [],
      domain: '.chatgpt.com',
      familyName: 'session-token',
    });

    expect(names(jar.path)).toEqual(['oai-did']);
  });
});

describe('applySetCookieToBrowserCookieJar', () => {
  it('rotates a chunked family from Set-Cookie headers', () => {
    const jar = jarFor('set-cookie-rotate');
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'session-token.0', value: 'old-0' },
      { domain: '.chatgpt.com', name: 'session-token.1', value: 'old-1' },
      { domain: '.chatgpt.com', name: '__cf_bm', value: 'cf-live' },
    ]);

    applySetCookieToBrowserCookieJar(
      jar.path,
      [
        'session-token=new-plain; Domain=.chatgpt.com; Path=/; Secure; HttpOnly',
        'session-token.1=; Domain=.chatgpt.com; Path=/; Max-Age=0',
      ],
      { defaultDomain: '.chatgpt.com' },
    );

    expect(names(jar.path)).toEqual(['__cf_bm', 'session-token']);
    expect(valueOf(jar.path, 'session-token')).toBe('new-plain');
    expect(valueOf(jar.path, '__cf_bm')).toBe('cf-live');
  });

  it('honors an allowlist so undeclared Set-Cookie names never enter', () => {
    const jar = jarFor('set-cookie-allow');
    applySetCookieToBrowserCookieJar(
      jar.path,
      [
        'oai-did=device-1; Domain=.chatgpt.com; Path=/',
        'tracking=nope; Domain=.chatgpt.com; Path=/',
      ],
      { allowedNames: ['oai-did'], defaultDomain: '.chatgpt.com' },
    );

    expect(names(jar.path)).toEqual(['oai-did']);
  });
});

describe('purgeExpiredBrowserCookies', () => {
  it('removes expired cookies and keeps session cookies', () => {
    const jar = jarFor('expiry');
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', expires: 10, name: 'stale', value: 'gone' },
      { domain: '.chatgpt.com', expires: 0, name: 'session', value: 'keep' },
    ]);

    purgeExpiredBrowserCookies(jar.path, 20_000);

    expect(names(jar.path)).toEqual(['session']);
  });
});

describe('cookie jar tombstone', () => {
  it('deleteBrowserCookieJar tombstones the path so seed/ensure cannot recreate it', () => {
    const jar = jarFor('tombstone-c4');
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'tombstone-c4' },
    ]);
    expect(existsSync(jar.path)).toBe(true);

    deleteBrowserCookieJar(jar.path);
    expect(existsSync(jar.path)).toBe(false);
    expect(isBrowserCookieJarTombstoned(jar.path)).toBe(true);

    ensureBrowserCookieJarFile(jar.path);
    seedBrowserCookieJar(jar.path, [
      { domain: '.chatgpt.com', name: 'oai-did', value: 'resurrected' },
    ]);
    expect(existsSync(jar.path)).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  describeCaughtError,
  formatDownloadFailure,
  libraryFileName,
  prepareDownloadRequest,
  sanitizeDownloadOrigin,
  shouldRefreshLibrary,
} from './lib';

/**
 * The pinned transport artifacts. `manifest.json` is the single source of truth for the
 * dev installer; the Dockerfile cannot read JSON, so it duplicates the two linux/musl
 * binary digests and the two linux-gnu library digests as build args — this test is what
 * keeps the copy honest.
 */
const HERE = path.dirname(new URL(import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf8')) as {
  assets: Record<string, { file: string; sha256: string }>;
  baseUrl: string;
  binaryName: string;
  libraries: Record<string, { file: string; member: string; sha256: string }>;
  version: string;
};
const dockerfile = readFileSync(path.resolve(HERE, '../../Dockerfile'), 'utf8');

const REQUIRED_ASSETS = [
  'aarch64-linux-musl',
  'x86_64-linux-musl',
  'arm64-macos',
  'x86_64-macos',
] as const;

describe('curl-impersonate manifest', () => {
  it('pins every OS/architecture the transport supports', () => {
    expect(Object.keys(manifest.assets).sort()).toEqual([...REQUIRED_ASSETS].sort());
  });

  it.each(REQUIRED_ASSETS)('%s carries a full sha256 and a versioned file name', (asset) => {
    const entry = manifest.assets[asset];

    expect(entry.sha256).toMatch(/^[\da-f]{64}$/);
    expect(entry.file).toBe(`curl-impersonate-${manifest.version}.${asset}.tar.gz`);
  });

  it('keeps the Dockerfile build args in sync with the manifest', () => {
    expect(dockerfile).toContain(`ARG CURL_IMPERSONATE_VERSION="${manifest.version}"`);
    expect(dockerfile).toContain(
      `ARG CURL_IMPERSONATE_SHA256_AARCH64="${manifest.assets['aarch64-linux-musl'].sha256}"`,
    );
    expect(dockerfile).toContain(
      `ARG CURL_IMPERSONATE_SHA256_X86_64="${manifest.assets['x86_64-linux-musl'].sha256}"`,
    );
    expect(dockerfile).toContain(
      `ARG LIBCURL_IMPERSONATE_SHA256_AARCH64="${manifest.libraries['aarch64-linux-musl'].sha256}"`,
    );
    expect(dockerfile).toContain(
      `ARG LIBCURL_IMPERSONATE_SHA256_X86_64="${manifest.libraries['x86_64-linux-musl'].sha256}"`,
    );
  });

  it('pins a gnu/macos library tarball for every OS/architecture the transport supports', () => {
    expect(Object.keys(manifest.libraries).sort()).toEqual([...REQUIRED_ASSETS].sort());
  });

  it.each(REQUIRED_ASSETS)(
    '%s library carries sha256, versioned file, and a real member',
    (asset) => {
      const entry = manifest.libraries[asset];

      expect(entry.sha256).toMatch(/^[\da-f]{64}$/);
      expect(entry.file.startsWith(`libcurl-impersonate-${manifest.version}.`)).toBe(true);
      expect(entry.file.endsWith('.tar.gz')).toBe(true);
      // Extract the REAL shared object, never the unversioned / soname symlink.
      if (asset.endsWith('-macos')) {
        expect(entry.member).toBe('libcurl-impersonate.4.8.0.dylib');
      } else {
        expect(entry.member).toBe('libcurl-impersonate.so.4.8.0');
      }
    },
  );

  it('libraryFileName is the stable name B1 resolves, not a versioned symlink', () => {
    expect(libraryFileName('darwin')).toBe('libcurl-impersonate.dylib');
    expect(libraryFileName('linux')).toBe('libcurl-impersonate.so');
  });

  /**
   * `CURL_IMPERSONATE_DOWNLOAD_BASE` is operator-supplied and may embed credentials; CI logs
   * are archived and widely readable, so only the origin is ever printed.
   */
  describe('sanitizeDownloadOrigin', () => {
    it.each([
      ['https://user:secret-password@mirror.internal:8443/pinned/curl.tar.gz'],
      ['https://mirror.internal:8443/pinned/curl.tar.gz?sig=SIGNATURE-SECRET'],
    ])('drops userinfo, path and query from %s', (url) => {
      const sanitized = sanitizeDownloadOrigin(url);

      expect(sanitized).toBe('https://mirror.internal:8443');
      expect(sanitized).not.toContain('secret-password');
      expect(sanitized).not.toContain('SIGNATURE-SECRET');
    });

    it('never throws on an unparseable base', () => {
      expect(sanitizeDownloadOrigin('not a url')).toBe('<invalid url>');
    });
  });

  describe('prepareDownloadRequest', () => {
    it('strips userinfo and sends it as Authorization: Basic', () => {
      const prepared = prepareDownloadRequest(
        'https://user:secret-password@mirror.example/pinned/lib.tar.gz?sig=SIGNATURE',
      );

      expect(prepared.url).toBe('https://mirror.example/pinned/lib.tar.gz?sig=SIGNATURE');
      expect(prepared.url).not.toContain('user');
      expect(prepared.url).not.toContain('secret-password');
      expect(prepared.headers.Authorization).toBe(
        `Basic ${Buffer.from('user:secret-password', 'utf8').toString('base64')}`,
      );
    });

    it('leaves a credential-free URL unchanged and adds no header', () => {
      const prepared = prepareDownloadRequest('https://mirror.example/pinned/lib.tar.gz');

      expect(prepared.url).toBe('https://mirror.example/pinned/lib.tar.gz');
      expect(prepared.headers.Authorization).toBeUndefined();
    });

    it('does not echo an unparseable input', () => {
      expect(() => prepareDownloadRequest('not a url')).toThrow('download failed: invalid url');
      try {
        prepareDownloadRequest('https://user:pass@not a url');
      } catch (error) {
        expect((error as Error).message).not.toContain('user:pass');
      }
    });
  });

  describe('formatDownloadFailure / describeCaughtError', () => {
    const dirty = 'https://user:pass@mirror.example/pinned/secret.tar.gz?sig=SIGNATURE';

    it('prints only the origin', () => {
      expect(formatDownloadFailure(dirty)).toBe('download failed from https://mirror.example');
      expect(formatDownloadFailure(dirty, { status: 403, statusText: 'Forbidden' })).toBe(
        'download failed: 403 Forbidden — https://mirror.example',
      );
    });

    it('replaces a Node fetch TypeError that embeds the full URL', () => {
      const described = describeCaughtError(
        new TypeError(`Failed to parse URL from ${dirty}`),
        dirty,
      );

      expect(described).toBe('download failed from https://mirror.example');
      expect(described).not.toContain('user:pass');
      expect(described).not.toContain('/pinned/');
      expect(described).not.toContain('SIGNATURE');
    });

    it('keeps a checksum message that has no URL', () => {
      expect(describeCaughtError(new Error('checksum mismatch for lib.tar.gz'), dirty)).toBe(
        'checksum mismatch for lib.tar.gz',
      );
    });
  });

  describe('shouldRefreshLibrary', () => {
    it('skips when the marker matches and the file is present', () => {
      expect(
        shouldRefreshLibrary({
          installedVersion: 'v2.1.0',
          libraryExists: true,
          manifestVersion: 'v2.1.0',
        }),
      ).toBe(false);
    });

    it('refreshes when the version changed, the file is missing, or the marker is absent', () => {
      expect(
        shouldRefreshLibrary({
          installedVersion: 'v2.0.0',
          libraryExists: true,
          manifestVersion: 'v2.1.0',
        }),
      ).toBe(true);
      expect(
        shouldRefreshLibrary({
          installedVersion: 'v2.1.0',
          libraryExists: false,
          manifestVersion: 'v2.1.0',
        }),
      ).toBe(true);
      expect(
        shouldRefreshLibrary({
          installedVersion: undefined,
          libraryExists: true,
          manifestVersion: 'v2.1.0',
        }),
      ).toBe(true);
    });
  });

  it('verifies the archive before extracting it, and fails closed', () => {
    const verify = dockerfile.indexOf('sha256sum -c -');
    const extract = dockerfile.indexOf('tar -xzf /tmp/curl-impersonate/curl-impersonate.tar.gz');

    expect(verify).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(verify);
    // A symlink entry would install a pointer at something else entirely.
    expect(dockerfile).toContain('test ! -L /tmp/curl-impersonate/curl-impersonate');
  });

  it('verifies the library archive before extracting the real .so, and fails closed', () => {
    const libraryVerify = dockerfile.indexOf(
      'sha256sum -c -',
      dockerfile.indexOf('libcurl-impersonate.tar.gz'),
    );
    const libraryExtract = dockerfile.indexOf(
      'tar -xzf /tmp/libcurl-impersonate/libcurl-impersonate.tar.gz',
    );

    expect(libraryVerify).toBeGreaterThan(-1);
    expect(libraryExtract).toBeGreaterThan(libraryVerify);
    expect(dockerfile).toContain('libcurl-impersonate.so.4.8.0');
    expect(dockerfile).toContain('test ! -L /tmp/libcurl-impersonate/libcurl-impersonate.so.4.8.0');
    expect(dockerfile).toContain('test ! -L /distroless/usr/local/lib/libcurl-impersonate.so');
    expect(dockerfile).toContain(
      'CHATGPT_WEB_LIBCURL_IMPERSONATE_PATH="/usr/local/lib/libcurl-impersonate.so"',
    );
  });
});

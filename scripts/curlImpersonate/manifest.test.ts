import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sanitizeDownloadOrigin } from './lib';

/**
 * The pinned transport artifacts. `manifest.json` is the single source of truth for the
 * dev installer; the Dockerfile cannot read JSON, so it duplicates the two linux/musl
 * digests as build args — this test is what keeps the copy honest.
 */
const HERE = path.dirname(new URL(import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf8')) as {
  assets: Record<string, { file: string; sha256: string }>;
  baseUrl: string;
  binaryName: string;
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

  it('verifies the archive before extracting it, and fails closed', () => {
    const verify = dockerfile.indexOf('sha256sum -c -');
    const extract = dockerfile.indexOf('tar -xzf /tmp/curl-impersonate/curl-impersonate.tar.gz');

    expect(verify).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(verify);
    // A symlink entry would install a pointer at something else entirely.
    expect(dockerfile).toContain('test ! -L /tmp/curl-impersonate/curl-impersonate');
  });
});

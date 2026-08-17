import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NETWORK_PROXY_ENGINE_MANIFEST,
  NETWORK_PROXY_ENGINE_PLATFORM_KEYS,
} from '../../packages/const/src/platform/networkProxy';
import { resolveEngineDownloadBase, sanitizeDownloadOrigin } from './lib';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const dockerfile = readFileSync(path.resolve(HERE, '../../Dockerfile'), 'utf8');

describe('network-proxy engine manifest', () => {
  it('pins exactly the three supported platforms', () => {
    expect(Object.keys(NETWORK_PROXY_ENGINE_MANIFEST.assets).sort()).toEqual(
      [...NETWORK_PROXY_ENGINE_PLATFORM_KEYS].sort(),
    );
  });

  it.each(NETWORK_PROXY_ENGINE_PLATFORM_KEYS)(
    '%s carries full sha256 digests, a gzip asset name and a binSize',
    (key) => {
      const entry = NETWORK_PROXY_ENGINE_MANIFEST.assets[key];
      expect(entry.binSha256).toMatch(/^[\da-f]{64}$/);
      expect(entry.gzSha256).toMatch(/^[\da-f]{64}$/);
      expect(entry.binSize).toBeGreaterThan(1_000_000);
      expect(entry.asset).toMatch(/\.gz$/);
      expect(entry.asset).toContain(NETWORK_PROXY_ENGINE_MANIFEST.version);
    },
  );

  it('does not bake the engine into the Docker image', () => {
    expect(dockerfile).toContain('NETWORK_PROXY_DATA_DIR=""');
    expect(dockerfile).toContain('NETWORK_PROXY_ENGINE_BIN=""');
    expect(dockerfile).toContain('NETWORK_PROXY_ENGINE_DOWNLOAD_BASE=""');
    expect(dockerfile).not.toContain('ARG NETWORK_PROXY_ENGINE_SHA256');
    expect(dockerfile).not.toContain(NETWORK_PROXY_ENGINE_MANIFEST.assets['linux:x64'].binSha256);
    expect(dockerfile).not.toContain(NETWORK_PROXY_ENGINE_MANIFEST.assets['linux:arm64'].binSha256);
  });

  describe('sanitizeDownloadOrigin', () => {
    it.each([
      ['https://user:secret-password@mirror.internal:8443/pinned/mihomo.gz'],
      ['https://mirror.internal:8443/pinned/mihomo.gz?sig=SIGNATURE-SECRET'],
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

  it('picks the CN mirror when USE_CN_MIRROR is truthy and no explicit base is set', () => {
    expect(resolveEngineDownloadBase({ USE_CN_MIRROR: 'true' })).toBe(
      NETWORK_PROXY_ENGINE_MANIFEST.cnMirrorBaseUrl,
    );
    expect(
      resolveEngineDownloadBase({
        NETWORK_PROXY_ENGINE_DOWNLOAD_BASE: 'https://mirror.example/mihomo',
        USE_CN_MIRROR: 'true',
      }),
    ).toBe('https://mirror.example/mihomo');
  });
});

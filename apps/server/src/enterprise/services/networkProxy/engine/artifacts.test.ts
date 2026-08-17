// @vitest-environment node
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NETWORK_PROXY_ENV } from '@/const/platform/networkProxy';
import { getEnterpriseErrorBody } from '@/server/enterprise/guards/enterpriseErrors';

import type { ArtifactSpec } from './artifacts';
import {
  artifactManager,
  getDigestHashCount,
  materializeGeodataIntoRuntime,
  resetArtifactCachesForTest,
  setResolveArtifactSpecForTest,
} from './artifacts';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'np-art-'));
  process.env[NETWORK_PROXY_ENV.DATA_DIR] = dataDir;
});

afterEach(() => {
  setResolveArtifactSpecForTest(null);
  resetArtifactCachesForTest();
  vi.restoreAllMocks();
  delete process.env[NETWORK_PROXY_ENV.ENGINE_BIN];
  rmSync(dataDir, { force: true, recursive: true });
});

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

const stubSpec = (size: number, digest: string, destName = 'geoip.metadb') => {
  const spec: ArtifactSpec = {
    compressed: 'none',
    destName,
    destParent: path.join(dataDir, 'geodata', 'test'),
    downloadUrl: 'https://example.com/geoip.metadb',
    kind: 'geoip',
    mode: 0o400,
    sha256: digest,
    size,
    version: 'test-commit',
  };
  setResolveArtifactSpecForTest(() => spec);
};

describe('artifactManager.installFromStream', () => {
  it('writes a matching geodata payload to the versioned path', async () => {
    const body = Buffer.from('geodata-fixture');
    stubSpec(body.length, sha256(body));
    const installed = await artifactManager.installFromStream('geoip', Readable.from(body), {
      compressed: 'none',
      source: 'upload',
    });
    expect(installed.sha256).toBe(sha256(body));
    expect(installed.source).toBe('upload');
    expect(installed.path).toBe(path.join(dataDir, 'geodata', 'test', 'geoip.metadb'));
  });

  it('throws PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH on digest failure', async () => {
    const body = Buffer.from('not-the-pinned-bytes');
    stubSpec(body.length, '0'.repeat(64));
    try {
      await artifactManager.installFromStream('geoip', Readable.from(body), {
        compressed: 'none',
        source: 'upload',
      });
      throw new Error('expected mismatch');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe('PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH');
    }
  });

  it('aborts a gzip bomb that exceeds the pinned decompressed size', async () => {
    const zeros = Buffer.alloc(64 * 1024, 0);
    const gz = gzipSync(zeros);
    stubSpec(1024, sha256(zeros));
    await expect(
      artifactManager.installFromStream('geoip', Readable.from(gz), {
        compressed: 'gzip',
        source: 'upload',
      }),
    ).rejects.toThrow(/decompressed artifact exceeds/);
  });

  it('aborts when the compressed stream exceeds 64 MiB', async () => {
    stubSpec(1024, '0'.repeat(64));
    let sent = 0;
    const huge = new Readable({
      read() {
        if (sent > 64 * 1024 * 1024) {
          this.push(null);
          return;
        }
        const chunk = Buffer.alloc(1024 * 1024, 1);
        sent += chunk.length;
        this.push(chunk);
      },
    });
    await expect(
      artifactManager.installFromStream('geoip', huge, { compressed: 'none', source: 'upload' }),
    ).rejects.toThrow(/compressed artifact exceeds/);
  });

  it('refuses a dest parent whose ancestor inside dataDir is a symlink', async () => {
    const real = path.join(dataDir, 'real-geo');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, path.join(dataDir, 'geodata'));
    const body = Buffer.from('x');
    setResolveArtifactSpecForTest(() => ({
      compressed: 'none',
      destName: 'geoip.metadb',
      destParent: path.join(dataDir, 'geodata', 'test'),
      downloadUrl: 'https://example.com/x',
      kind: 'geoip',
      mode: 0o400,
      sha256: sha256(body),
      size: 1,
      version: 'x',
    }));
    await expect(
      artifactManager.installFromStream('geoip', Readable.from(body), {
        compressed: 'none',
        source: 'upload',
      }),
    ).rejects.toThrow(/symlink/i);
  });

  it('refuses to install when the target directory is a symlink', async () => {
    const real = path.join(dataDir, 'real-geo');
    const link = path.join(dataDir, 'link-geo');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const body = Buffer.from('x');
    setResolveArtifactSpecForTest(() => ({
      compressed: 'none',
      destName: 'geoip.metadb',
      destParent: link,
      downloadUrl: 'https://example.com/x',
      kind: 'geoip',
      mode: 0o400,
      sha256: sha256(body),
      size: 1,
      version: 'x',
    }));
    await expect(
      artifactManager.installFromStream('geoip', Readable.from(body), {
        compressed: 'none',
        source: 'upload',
      }),
    ).rejects.toThrow(/symlink/i);
  });
});

describe('materializeGeodataIntoRuntime', () => {
  it('throws ARTIFACT_MISMATCH when the on-disk geodata digest is wrong', async () => {
    const junk = Buffer.from('not-pinned-geodata');
    stubSpec(junk.length, 'ab'.repeat(32));
    const destParent = path.join(dataDir, 'geodata', 'test');
    mkdirSync(destParent, { recursive: true, mode: 0o700 });
    const dest = path.join(destParent, 'geoip.metadb');
    writeFileSync(dest, junk);
    try {
      await materializeGeodataIntoRuntime(path.join(dataDir, 'runtime'));
      throw new Error('expected mismatch');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe('PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH');
    }
  });
});

describe('verify cache vs spawn re-verify', () => {
  it('rehashes only when reverify is requested', async () => {
    const body = Buffer.from('cached-geo');
    stubSpec(body.length, sha256(body));
    await artifactManager.installFromStream('geoip', Readable.from(body), {
      compressed: 'none',
      source: 'upload',
    });
    const afterInstall = getDigestHashCount();
    await artifactManager.getStatus();
    expect(getDigestHashCount()).toBe(afterInstall);
    const dest = path.join(dataDir, 'geodata', 'test', 'geoip.metadb');
    const { materializeGeodataIntoRuntime, verifyPinnedFile } = await import('./artifacts');
    await materializeGeodataIntoRuntime(path.join(dataDir, 'runtime'));
    expect(getDigestHashCount()).toBe(afterInstall);
    await verifyPinnedFile(dest, sha256(body), { reverify: true });
    expect(getDigestHashCount()).toBeGreaterThan(afterInstall);
  });

  it('refuses a mutated file on a later forced re-verify', async () => {
    const body = Buffer.from('spawn-verify');
    stubSpec(body.length, sha256(body));
    await artifactManager.installFromStream('geoip', Readable.from(body), {
      compressed: 'none',
      source: 'upload',
    });
    const dest = path.join(dataDir, 'geodata', 'test', 'geoip.metadb');
    const { verifyPinnedFile } = await import('./artifacts');
    await verifyPinnedFile(dest, sha256(body), { reverify: true });
    chmodSync(dest, 0o600);
    writeFileSync(dest, 'mutated');
    try {
      await verifyPinnedFile(dest, sha256(body), { reverify: true });
      throw new Error('expected mismatch');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe('PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH');
    }
  });
});

describe('artifactManager.resolveEngineBinary', () => {
  it('accepts NETWORK_PROXY_ENGINE_BIN as an unverified operator override', async () => {
    process.env[NETWORK_PROXY_ENV.ENGINE_BIN] = '/usr/bin/true';
    const resolved = await artifactManager.resolveEngineBinary();
    expect(resolved?.source).toBe('operator_override');
    expect(resolved?.path).toBe('/usr/bin/true');
    expect(resolved?.sha256).toBe('');
  });
});

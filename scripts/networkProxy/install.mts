#!/usr/bin/env tsx
/**
 * Download the pinned mihomo engine for this machine into
 * `<repo>/.cache/network-proxy/engine/<version>/`.
 *
 *   bun run network-proxy:install
 *
 * The release, URL and per-asset SHA-256 come from `NETWORK_PROXY_ENGINE_MANIFEST`
 * in `packages/const` — there is no JSON manifest. An artifact that does not match
 * its digest is NEVER installed.
 *
 * Env:
 *   NETWORK_PROXY_ENGINE_DOWNLOAD_BASE  mirror prefix (default: GitHub or USE_CN_MIRROR)
 *   USE_CN_MIRROR                       when truthy, use the ghfast.top prefix
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { NETWORK_PROXY_ENGINE_MANIFEST } from '../../packages/const/src/platform/networkProxy';
import {
  resolveCurrentEngineAsset,
  resolveEngineDownloadBase,
  sanitizeDownloadOrigin,
} from './lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const TARGET_DIR = path.join(
  REPO_ROOT,
  '.cache',
  'network-proxy',
  'engine',
  NETWORK_PROXY_ENGINE_MANIFEST.version,
);

const fail = (message: string): never => {
  console.error(`✖ ${message}`);
  process.exit(1);
  throw new Error(message);
};

const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    fail(
      `download failed: ${response.status} ${response.statusText} — ${sanitizeDownloadOrigin(url)}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
};

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

const main = async () => {
  const current = resolveCurrentEngineAsset();
  if (!current) {
    return fail(
      `network proxy engine has no release asset for ${process.platform}:${process.arch}. Supported: linux:x64, linux:arm64, darwin:arm64.`,
    );
  }
  const { asset } = current;
  const url = `${resolveEngineDownloadBase()}/${NETWORK_PROXY_ENGINE_MANIFEST.version}/${asset.asset}`;

  console.log(`↓ ${asset.asset} from ${sanitizeDownloadOrigin(url)}`);
  const compressed = await download(url);

  if (compressed.byteLength > 64 * 1024 * 1024) {
    fail(`compressed artifact is larger than 64 MiB (${compressed.byteLength} bytes)`);
  }
  const gzDigest = sha256(compressed);
  if (gzDigest !== asset.gzSha256) {
    fail(
      `gzip checksum mismatch for ${asset.asset}\n  expected ${asset.gzSha256}\n  received ${gzDigest}\nRefusing to install.`,
    );
  }
  console.log(`✔ gz sha256 ${gzDigest}`);

  const binary = gunzipSync(compressed);
  if (binary.byteLength > asset.binSize) {
    fail(`decompressed artifact exceeds pinned size (${binary.byteLength} > ${asset.binSize})`);
  }
  const binDigest = sha256(binary);
  if (binDigest !== asset.binSha256) {
    fail(
      `binary checksum mismatch for ${asset.asset}\n  expected ${asset.binSha256}\n  received ${binDigest}\nRefusing to install.`,
    );
  }
  console.log(`✔ bin sha256 ${binDigest} (${binary.byteLength} bytes)`);

  mkdirSync(TARGET_DIR, { recursive: true, mode: 0o700 });
  if (lstatSync(TARGET_DIR).isSymbolicLink()) {
    fail(`refusing to install into a symlinked directory: ${TARGET_DIR}`);
  }
  const dest = path.join(
    TARGET_DIR,
    `${NETWORK_PROXY_ENGINE_MANIFEST.binaryName}-${binDigest.slice(0, 16)}`,
  );
  if (existsSync(dest)) {
    const existing = lstatSync(dest);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      fail(`existing destination is not a regular file: ${dest}`);
    }
    const existingDigest = sha256(readFileSync(dest));
    if (existingDigest !== asset.binSha256) {
      fail(
        `existing destination digest mismatch\n  expected ${asset.binSha256}\n  received ${existingDigest}`,
      );
    }
    console.log(`✔ already installed at ${dest}`);
  } else {
    // Staging lives NEXT TO the target so the final install is a same-filesystem rename.
    const staging = mkdtempSync(path.join(TARGET_DIR, '.staging-'));
    try {
      const staged = path.join(staging, NETWORK_PROXY_ENGINE_MANIFEST.binaryName);
      const fd = openSync(staged, 'wx', 0o500);
      try {
        writeSync(fd, binary);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(staged, 0o500);
      renameSync(staged, dest);
    } finally {
      rmSync(staging, { force: true, recursive: true });
    }
  }

  const version = execFileSync(dest, ['-v'], { encoding: 'utf8' }).trim().split('\n')[0];
  console.log(`✔ ${dest}`);
  console.log(`  ${version}`);
  console.log(
    `  Set NETWORK_PROXY_ENGINE_BIN=${dest} to pin it explicitly (the supervisor also discovers this path).`,
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { TARGET_DIR };

#!/usr/bin/env tsx
/**
 * Download the `curl-impersonate` binary used by the ChatGPT Web provider transport.
 *
 * chatgpt.com is behind Cloudflare bot-fight: Node's own fetch is answered with a 403
 * challenge whatever headers it sends, because the TLS/HTTP2 fingerprint is what gets
 * checked. Development therefore needs the same binary the Docker image ships.
 *
 *   bun run curl-impersonate:install
 *
 * The release, its URL and the per-asset SHA-256 come from `manifest.json` — the single
 * place that pins them (the Dockerfile duplicates the two linux/musl digests because a
 * shell stage cannot read JSON). An artifact that does not match its digest is NEVER
 * extracted: HTTPS proves who served the file, not that the file is the one we reviewed,
 * and this one gets executed with the server's credentials in its environment.
 *
 * Env:
 *   CURL_IMPERSONATE_DOWNLOAD_BASE  mirror prefix (default: the manifest's baseUrl)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSET_ARCH, sanitizeDownloadOrigin } from './lib';

interface CurlImpersonateAsset {
  file: string;
  sha256: string;
}

interface CurlImpersonateManifest {
  assets: Record<string, CurlImpersonateAsset | undefined>;
  baseUrl: string;
  binaryName: string;
  version: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(HERE, 'manifest.json');

export const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as CurlImpersonateManifest;

const TARGET_DIR = path.resolve(process.cwd(), '.cache', manifest.binaryName);
const TARGET_PATH = path.join(TARGET_DIR, manifest.binaryName);

const fail = (message: string): never => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

export const resolveAssetKey = (platform: string, arch: string): string => {
  const key = ASSET_ARCH[`${platform}:${arch}`];
  if (!key) {
    fail(
      `curl-impersonate has no release asset for ${platform}:${arch}. Supported: ${Object.keys(ASSET_ARCH).join(', ')}.`,
    );
  }
  return key!;
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

const main = async () => {
  const assetKey = resolveAssetKey(process.platform, process.arch);
  const asset = manifest.assets[assetKey];
  if (!asset) fail(`manifest.json has no pinned digest for ${assetKey}`);

  const base = process.env.CURL_IMPERSONATE_DOWNLOAD_BASE || manifest.baseUrl;
  const url = `${base}/${manifest.version}/${asset!.file}`;

  console.log(`↓ ${asset!.file} from ${sanitizeDownloadOrigin(url)}`);
  const tarball = await download(url);

  const digest = createHash('sha256').update(tarball).digest('hex');
  if (digest !== asset!.sha256) {
    fail(
      `checksum mismatch for ${asset!.file}\n  expected ${asset!.sha256}\n  received ${digest}\nRefusing to install; the mirror served something other than the pinned release.`,
    );
  }
  console.log(`✔ sha256 ${digest}`);

  mkdirSync(TARGET_DIR, { recursive: true });
  // Staging lives NEXT TO the target so the final install is a same-filesystem rename
  // (a tmpfs `/tmp` would make it EXDEV and force a non-atomic copy).
  const staging = mkdtempSync(path.join(TARGET_DIR, '.staging-'));
  try {
    const archive = path.join(staging, 'curl-impersonate.tar.gz');
    writeFileSync(archive, tarball);

    // Extract ONLY the binary, into staging: the tarball also ships ~40 `curl_<browser>`
    // wrapper scripts whose baked-in header sets the transport deliberately replaces.
    execFileSync('tar', ['-xzf', archive, '-C', staging, manifest.binaryName], {
      stdio: 'inherit',
    });

    const staged = path.join(staging, manifest.binaryName);
    if (!existsSync(staged)) fail(`archive did not contain a ${manifest.binaryName} entry`);
    // lstat, not stat: a symlink entry would install a pointer at something else entirely.
    if (!lstatSync(staged).isFile()) {
      fail(`${manifest.binaryName} in the archive is not a regular file`);
    }
    chmodSync(staged, 0o755);

    const version = execFileSync(staged, ['--version'], { encoding: 'utf8' }).split('\n')[0];

    // Atomic install: a concurrent process never observes a half-written binary.
    renameSync(staged, TARGET_PATH);

    console.log(`✔ ${TARGET_PATH}`);
    console.log(`  ${version}`);
    console.log(
      `  Set CHATGPT_WEB_CURL_IMPERSONATE_BIN=${TARGET_PATH} to pin it explicitly (auto-discovered otherwise).`,
    );
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
};

// Importable for tests; only the direct invocation installs anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

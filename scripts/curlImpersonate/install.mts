#!/usr/bin/env tsx
/**
 * Download the `curl-impersonate` binary **and** `libcurl-impersonate` shared library
 * used by the ChatGPT Web provider transport.
 *
 * chatgpt.com is behind Cloudflare bot-fight: Node's own fetch is answered with a 403
 * challenge whatever headers it sends, because the TLS/HTTP2 fingerprint is what gets
 * checked. Development therefore needs the same artifacts the Docker image ships.
 *
 *   bun run curl-impersonate:install
 *
 * The release, its URL and the per-asset SHA-256 come from `manifest.json` — the single
 * place that pins them (the Dockerfile duplicates the linux digests because a shell stage
 * cannot read JSON). An artifact that does not match its digest is NEVER extracted: HTTPS
 * proves who served the file, not that the file is the one we reviewed, and these artifacts
 * run with the server's credentials in their environment.
 *
 * The binary install is fatal on failure. The library install is not: without it the
 * server falls back to the CLI transport.
 *
 * Env:
 *   CURL_IMPERSONATE_DOWNLOAD_BASE  mirror prefix (default: the manifest's baseUrl).
 *   Userinfo is stripped and sent as `Authorization: Basic` (Node `fetch` rejects
 *   credential-bearing URLs). Logs print only scheme+host, never userinfo/path/query.
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

import type { PreparedDownloadRequest } from './lib';
import {
  ASSET_ARCH,
  describeCaughtError,
  formatDownloadFailure,
  LIBRARY_VERSION_MARKER,
  libraryFileName,
  prepareDownloadRequest,
  sanitizeDownloadOrigin,
  shouldRefreshLibrary,
} from './lib';

interface CurlImpersonateAsset {
  file: string;
  sha256: string;
}

interface CurlImpersonateLibraryAsset {
  file: string;
  member: string;
  sha256: string;
}

interface CurlImpersonateManifest {
  assets: Record<string, CurlImpersonateAsset | undefined>;
  baseUrl: string;
  binaryName: string;
  libraries: Record<string, CurlImpersonateLibraryAsset | undefined>;
  version: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(HERE, 'manifest.json');

export const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as CurlImpersonateManifest;

const TARGET_DIR = path.resolve(process.cwd(), '.cache', manifest.binaryName);
const TARGET_PATH = path.join(TARGET_DIR, manifest.binaryName);

// A function DECLARATION (not a const arrow): TypeScript only treats a call as an
// assertion / never-returning control-flow exit when the callee's declared type carries
// the explicit `never` annotation, which an inferred const type does not.
function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

export const resolveAssetKey = (platform: string, arch: string): string => {
  const key = ASSET_ARCH[`${platform}:${arch}`];
  if (!key) {
    fail(
      `curl-impersonate has no release asset for ${platform}:${arch}. Supported: ${Object.keys(ASSET_ARCH).join(', ')}.`,
    );
  }
  return key!;
};

/**
 * Fetch a tarball. Userinfo is stripped and sent as `Authorization: Basic` so Node
 * `fetch` will accept the URL. Failures never include the raw URL (Node's TypeError
 * embeds userinfo / path / signed query).
 */
export const download = async (url: string): Promise<Buffer> => {
  let prepared: PreparedDownloadRequest;
  try {
    prepared = prepareDownloadRequest(url);
  } catch {
    throw new Error(formatDownloadFailure(url));
  }

  let response: Response;
  try {
    response = await fetch(prepared.url, { headers: prepared.headers, redirect: 'follow' });
  } catch {
    throw new Error(formatDownloadFailure(url));
  }

  if (!response.ok) {
    throw new Error(
      formatDownloadFailure(url, { status: response.status, statusText: response.statusText }),
    );
  }
  return Buffer.from(await response.arrayBuffer());
};

const verifyTarball = (tarball: Buffer, expectedSha256: string, file: string): string => {
  const digest = createHash('sha256').update(tarball).digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(
      `checksum mismatch for ${file}\n  expected ${expectedSha256}\n  received ${digest}\nRefusing to install; the mirror served something other than the pinned release.`,
    );
  }
  return digest;
};

const extractRegularMember = (archive: string, staging: string, member: string): string => {
  execFileSync('tar', ['-xzf', archive, '-C', staging, member], { stdio: 'inherit' });
  const staged = path.join(staging, member);
  if (!existsSync(staged)) throw new Error(`archive did not contain a ${member} entry`);
  // lstat, not stat: a symlink entry would install a pointer at something else entirely.
  if (!lstatSync(staged).isFile()) {
    throw new Error(`${member} in the archive is not a regular file`);
  }
  chmodSync(staged, 0o755);
  return staged;
};

export const warnLibraryFailure = (reason: string): void => {
  console.warn(`⚠ libcurl-impersonate library was not installed: ${reason}`);
  console.warn('  no library installed → CLI fallback');
};

const readInstalledLibraryVersion = (dir: string): string | undefined => {
  try {
    const text = readFileSync(path.join(dir, LIBRARY_VERSION_MARKER), 'utf8').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
};

const dropStableLibrary = (dir: string, platform: string): void => {
  rmSync(path.join(dir, libraryFileName(platform)), { force: true });
  rmSync(path.join(dir, LIBRARY_VERSION_MARKER), { force: true });
};

const logLibraryPathHint = (dest: string): void => {
  console.log(
    `  Set CHATGPT_WEB_LIBCURL_IMPERSONATE_PATH=${dest} to pin it explicitly (auto-discovered otherwise).`,
  );
};

export interface InstallLibraryOptions {
  assetKey: string;
  base: string;
  manifestVersion?: string;
  platform?: string;
  targetDir?: string;
}

/**
 * Install (or skip) the shared library. When the installed version marker does not match
 * the manifest, the stable `.dylib`/`.so` is removed **before** the download so a failed
 * upgrade cannot leave a stale library that the resolver would still load.
 */
export const installLibrary = async (
  options: InstallLibraryOptions,
): Promise<'installed' | 'skipped'> => {
  const targetDir = options.targetDir ?? TARGET_DIR;
  const platform = options.platform ?? process.platform;
  const version = options.manifestVersion ?? manifest.version;
  const library = manifest.libraries[options.assetKey];
  if (!library)
    throw new Error(`manifest.json has no pinned library digest for ${options.assetKey}`);

  const dest = path.join(targetDir, libraryFileName(platform));
  const marker = path.join(targetDir, LIBRARY_VERSION_MARKER);
  const libraryExists = existsSync(dest) && lstatSync(dest).isFile();

  if (
    !shouldRefreshLibrary({
      installedVersion: readInstalledLibraryVersion(targetDir),
      libraryExists,
      manifestVersion: version,
    })
  ) {
    console.log(`✔ ${dest} (already ${version})`);
    logLibraryPathHint(dest);
    return 'skipped';
  }

  // Version changed or unknown: drop the stable name first so a failed download
  // cannot leave a previous release's library active.
  dropStableLibrary(targetDir, platform);

  const url = `${options.base}/${version}/${library.file}`;
  console.log(`↓ ${library.file} from ${sanitizeDownloadOrigin(url)}`);
  const tarball = await download(url);
  const digest = verifyTarball(tarball, library.sha256, library.file);
  console.log(`✔ sha256 ${digest}`);

  mkdirSync(targetDir, { recursive: true });
  const staging = mkdtempSync(path.join(targetDir, '.staging-lib-'));
  try {
    const archive = path.join(staging, 'libcurl-impersonate.tar.gz');
    writeFileSync(archive, tarball);

    // Extract the REAL shared object (not the soname / unversioned symlink), then
    // install it under the stable name B1's resolver looks for.
    const staged = extractRegularMember(archive, staging, library.member);
    renameSync(staged, dest);
    writeFileSync(marker, `${version}\n`, 'utf8');
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }

  console.log(`✔ ${dest}`);
  logLibraryPathHint(dest);
  return 'installed';
};

const main = async () => {
  const assetKey = resolveAssetKey(process.platform, process.arch);
  const asset = manifest.assets[assetKey];
  if (!asset) fail(`manifest.json has no pinned digest for ${assetKey}`);

  const base = process.env.CURL_IMPERSONATE_DOWNLOAD_BASE || manifest.baseUrl;
  const url = `${base}/${manifest.version}/${asset.file}`;

  console.log(`↓ ${asset.file} from ${sanitizeDownloadOrigin(url)}`);
  let tarball: Buffer;
  try {
    tarball = await download(url);
  } catch (error) {
    fail(describeCaughtError(error, url));
  }

  let digest: string;
  try {
    digest = verifyTarball(tarball, asset.sha256, asset.file);
  } catch (error) {
    fail(describeCaughtError(error, url));
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
    let staged: string;
    try {
      staged = extractRegularMember(archive, staging, manifest.binaryName);
    } catch (error) {
      fail(describeCaughtError(error, url));
    }

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

  try {
    await installLibrary({ assetKey, base });
  } catch (error) {
    warnLibraryFailure(describeCaughtError(error, `${base}/${manifest.version}`));
  }
};

// Importable for tests; only the direct invocation installs anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

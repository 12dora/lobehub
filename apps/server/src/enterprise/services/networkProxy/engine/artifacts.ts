import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';

import debug from 'debug';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

import type {
  NetworkProxyArtifactKind,
  NetworkProxyArtifactSource,
  NetworkProxyEngineAsset,
  NetworkProxyGeodataFile,
} from '@/const/platform/networkProxy';
import {
  NETWORK_PROXY_ENGINE_MANIFEST,
  NETWORK_PROXY_ENV,
  NETWORK_PROXY_LIMITS,
} from '@/const/platform/networkProxy';
import type { ArtifactState } from '@/types/platform/networkProxy';

import { redactUrlForDisplay } from './b1';
import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';
import { ensureSecureDirectory, removeIfPresent, withInstallLock } from './fsSecure';
import { detectEnginePlatform, enginePaths, resolveDataDir } from './platform';

const log = debug('lobe-server:network-proxy-artifacts');
const execFileAsync = promisify(execFile);
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const SMOKE_TIMEOUT_MS = 10_000;

export interface InstalledArtifact {
  kind: NetworkProxyArtifactKind;
  path: string;
  /**
   * false when the file's sha256 differs from the pinned manifest digest and an operator
   * explicitly accepted it at upload time (design §3.2 escape hatch). Never true by accident:
   * the acceptance is a side-file next to the artifact, written only by the upload path.
   */
  pinnedDigestMatch: boolean;
  sha256: string;
  smokeOutput?: string | null;
  source: NetworkProxyArtifactSource;
  version: string;
}

export interface ResolveEngineBinaryOptions {
  /** Force a fresh sha256 of the versioned file (spawn path). */
  reverify?: boolean;
}

interface FileIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
  path: string;
  size: number;
}

interface DigestCacheEntry {
  digest: string;
  identity: FileIdentity;
}

export interface ArtifactSpec {
  compressed: 'gzip' | 'none';
  destName: string;
  destParent: string;
  downloadUrl: string;
  kind: NetworkProxyArtifactKind;
  mode: number;
  sha256: string;
  size: number;
  version: string;
}

const isTruthyEnv = (value: string | undefined): boolean =>
  ['1', 'on', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());

const engineDownloadBase = (): string => {
  const override = process.env[NETWORK_PROXY_ENV.ENGINE_DOWNLOAD_BASE]?.trim();
  if (override) return override.replace(/\/+$/u, '');
  return isTruthyEnv(process.env.USE_CN_MIRROR)
    ? NETWORK_PROXY_ENGINE_MANIFEST.cnMirrorBaseUrl
    : NETWORK_PROXY_ENGINE_MANIFEST.baseUrl;
};

const geodataDownloadBase = (): string =>
  isTruthyEnv(process.env.USE_CN_MIRROR)
    ? NETWORK_PROXY_ENGINE_MANIFEST.geodata.cnMirrorBaseUrl
    : NETWORK_PROXY_ENGINE_MANIFEST.geodata.baseUrl;

export const engineBinaryFileName = (binSha256: string): string =>
  `${NETWORK_PROXY_ENGINE_MANIFEST.binaryName}-${binSha256.slice(0, 16)}`;

const currentEngineAsset = (): {
  asset: NetworkProxyEngineAsset;
  key: NonNullable<ReturnType<typeof detectEnginePlatform>['key']>;
} | null => {
  const { key } = detectEnginePlatform();
  if (!key) return null;
  return { asset: NETWORK_PROXY_ENGINE_MANIFEST.assets[key], key };
};

const resolveArtifactSpecFromManifest = (kind: NetworkProxyArtifactKind): ArtifactSpec => {
  const dataDir = resolveDataDir();
  const paths = enginePaths(dataDir);
  if (kind === 'engine') {
    const current = currentEngineAsset();
    if (!current) {
      return throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.UNSUPPORTED_PLATFORM);
    }
    const { asset } = current;
    return {
      compressed: 'gzip',
      destName: engineBinaryFileName(asset.binSha256),
      destParent: path.join(paths.engineDir, NETWORK_PROXY_ENGINE_MANIFEST.version),
      downloadUrl: `${engineDownloadBase()}/${NETWORK_PROXY_ENGINE_MANIFEST.version}/${asset.asset}`,
      kind,
      mode: 0o500,
      sha256: asset.binSha256,
      size: asset.binSize,
      version: NETWORK_PROXY_ENGINE_MANIFEST.version,
    };
  }
  const file: NetworkProxyGeodataFile = NETWORK_PROXY_ENGINE_MANIFEST.geodata.files[kind];
  const commit = NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit;
  return {
    compressed: 'none',
    destName: file.file,
    destParent: path.join(paths.geodataDir, commit),
    downloadUrl: `${geodataDownloadBase()}/${commit}/${file.file}`,
    kind,
    mode: 0o400,
    sha256: file.sha256,
    size: file.size,
    version: commit,
  };
};

let specResolver: ((kind: NetworkProxyArtifactKind) => ArtifactSpec) | null = null;

export const resolveArtifactSpec = (kind: NetworkProxyArtifactKind): ArtifactSpec =>
  specResolver ? specResolver(kind) : resolveArtifactSpecFromManifest(kind);

/** Test seam — swap the spec resolver without rewriting the pinned manifest. */
export const setResolveArtifactSpecForTest = (
  resolver: ((kind: NetworkProxyArtifactKind) => ArtifactSpec) | null,
): void => {
  specResolver = resolver;
};

const digestCache = new Map<string, DigestCacheEntry>();
let overrideSmoke: { path: string; smokeOutput: string; version: string } | null = null;
let lastSmokeOutput: string | null = null;
let afterReverifyHook: (() => void | Promise<void>) | null = null;
let spawnDigestVerifyCount = 0;
let digestHashCount = 0;

export const getSpawnDigestVerifyCount = (): number => spawnDigestVerifyCount;
export const getDigestHashCount = (): number => digestHashCount;

const identityOf = (
  path: string,
  stat: { dev: number; ino: bigint | number; mtimeMs: number; size: number },
): FileIdentity => ({
  dev: Number(stat.dev),
  ino: Number(stat.ino),
  mtimeMs: Number(stat.mtimeMs),
  path,
  size: Number(stat.size),
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.path === right.path &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs;

const hashNoFollow = async (path: string): Promise<{ digest: string; identity: FileIdentity }> => {
  digestHashCount += 1;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('artifact is not a regular file');
    const hash = createHash('sha256');
    await pipeline(handle.createReadStream(), hash);
    return { digest: hash.digest('hex'), identity: identityOf(path, stat) };
  } finally {
    await handle.close();
  }
};

/** Side-file that records a digest an operator explicitly accepted despite the manifest mismatch. */
export const acceptedDigestPath = (artifactPath: string): string => `${artifactPath}.accepted`;

const readAcceptedDigest = async (artifactPath: string): Promise<string | null> => {
  try {
    const handle = await open(
      acceptedDigestPath(artifactPath),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 128) return null;
      const text = (await handle.readFile({ encoding: 'utf8' })).trim().toLowerCase();
      return /^[\da-f]{64}$/u.test(text) ? text : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

const writeAcceptedDigest = async (artifactPath: string, digest: string): Promise<void> => {
  const target = acceptedDigestPath(artifactPath);
  await removeIfPresent(target);
  const handle = await open(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(`${digest}\n`, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * A digest is acceptable when it equals the pinned manifest digest, or when it equals the
 * operator-accepted digest recorded next to the file. The second path exists only for a manual
 * upload where the administrator saw the mismatch warning and chose to proceed.
 */
const isAcceptableDigest = async (
  path: string,
  digest: string,
  expectedSha256: string,
): Promise<{ matched: boolean; ok: boolean }> => {
  if (digest === expectedSha256) return { matched: true, ok: true };
  const accepted = await readAcceptedDigest(path);
  return { matched: false, ok: accepted !== null && accepted === digest };
};

export const verifyPinnedFile = async (
  path: string,
  expectedSha256: string,
  opts?: { reverify?: boolean },
): Promise<{ digest: string; identity: FileIdentity; pinnedDigestMatch: boolean }> => {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH);
  }
  const identity = identityOf(path, stat);
  const cached = digestCache.get(path);
  if (!opts?.reverify && cached && sameIdentity(cached.identity, identity)) {
    const verdict = await isAcceptableDigest(path, cached.digest, expectedSha256);
    if (!verdict.ok) {
      digestCache.delete(path);
      return throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH);
    }
    return { digest: cached.digest, identity, pinnedDigestMatch: verdict.matched };
  }
  if (opts?.reverify) spawnDigestVerifyCount += 1;
  const hashed = await hashNoFollow(path);
  const verdict = await isAcceptableDigest(path, hashed.digest, expectedSha256);
  if (!verdict.ok) {
    digestCache.delete(path);
    return throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH);
  }
  digestCache.set(path, { digest: hashed.digest, identity: hashed.identity });
  if (opts?.reverify) await afterReverifyHook?.();
  return { ...hashed, pinnedDigestMatch: verdict.matched };
};

/** Test seam: run after a successful forced re-verify (used to mutate the file between spawn attempts). */
export const setAfterReverifyForTest = (hook: (() => void | Promise<void>) | null): void => {
  afterReverifyHook = hook;
};

export const rememberPinnedDigest = async (path: string, digest: string): Promise<void> => {
  const stat = await lstat(path);
  if (stat.isFile() && !stat.isSymbolicLink()) {
    digestCache.set(path, { digest, identity: identityOf(path, stat) });
  }
};

export const getLastEngineSmokeOutput = (): string | null => lastSmokeOutput;

export const resetArtifactCachesForTest = (): void => {
  afterReverifyHook = null;
  digestCache.clear();
  digestHashCount = 0;
  lastSmokeOutput = null;
  overrideSmoke = null;
  spawnDigestVerifyCount = 0;
};

const parseMihomoVersion = (output: string): string | null => {
  const match = /v?\d+\.\d+\.\d+/u.exec(output);
  return match?.[0] ? (match[0].startsWith('v') ? match[0] : `v${match[0]}`) : null;
};

export const smokeTestEngineBinary = async (
  binPath: string,
): Promise<{ smokeOutput: string; version: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, ['-v'], {
      timeout: SMOKE_TIMEOUT_MS,
    });
    const text = `${stdout}\n${stderr}`;
    const firstLine = text.trim().split('\n')[0] ?? 'unknown';
    lastSmokeOutput = firstLine;
    return {
      smokeOutput: firstLine,
      version: parseMihomoVersion(text) ?? firstLine,
    };
  } catch {
    return throwNetworkProxyError(
      NETWORK_PROXY_ENGINE_ERROR_CODES.ENGINE_ERROR,
      'engine binary failed the -v smoke test',
    );
  }
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

const toNodeReadable = (stream: NodeJS.ReadableStream): Readable =>
  stream instanceof Readable ? stream : Readable.from(stream as AsyncIterable<Buffer>);

const writeStreamToVerifiedFile = async (input: {
  /** Keep the file even when the digest differs from `expectedSha256` (operator-accepted upload). */
  acceptMismatch?: boolean;
  compressed: 'auto' | 'gzip' | 'none';
  expectedSha256: string;
  maxCompressed: number;
  maxDecompressed: number;
  mode: number;
  stream: NodeJS.ReadableStream;
  tmpPath: string;
}): Promise<{ digest: string; matched: boolean }> => {
  const handle = await open(
    input.tmpPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash('sha256');
  let compressed = 0;
  let decompressed = 0;
  let encoding: 'gzip' | 'none' = input.compressed === 'gzip' ? 'gzip' : 'none';

  const fail = async (error: unknown): Promise<never> => {
    await handle.close().catch(() => undefined);
    await removeIfPresent(input.tmpPath);
    throw error;
  };

  try {
    const source = toNodeReadable(input.stream);
    const iterator = source[Symbol.asyncIterator]();
    const first = await iterator.next();
    const prefix = first.done
      ? Buffer.alloc(0)
      : Buffer.isBuffer(first.value)
        ? first.value
        : Buffer.from(first.value ?? '');
    if (input.compressed === 'auto' && prefix.length >= 2) {
      encoding = prefix[0] === GZIP_MAGIC_0 && prefix[1] === GZIP_MAGIC_1 ? 'gzip' : 'none';
    }
    const headed = Readable.from(
      (async function* prepend() {
        if (prefix.length) yield prefix;

        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          yield next.value;
        }
      })(),
    );

    const countCompressed = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        compressed += chunk.length;
        if (compressed > input.maxCompressed) {
          callback(new Error('compressed artifact exceeds the 64 MiB cap'));
          return;
        }
        callback(null, chunk);
      },
    });
    const countDecompressed = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        decompressed += chunk.length;
        if (decompressed > input.maxDecompressed) {
          callback(new Error('decompressed artifact exceeds the pinned size cap'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const dest = new Writable({
      write(chunk: Buffer, _enc, callback) {
        void handle.write(chunk).then(() => callback(), callback);
      },
    });

    if (encoding === 'gzip') {
      await pipeline(headed, countCompressed, createGunzip(), countDecompressed, dest);
    } else {
      await pipeline(headed, countCompressed, countDecompressed, dest);
    }

    const digest = hash.digest('hex');
    const matched = digest === input.expectedSha256;
    if (!matched && !input.acceptMismatch) {
      await handle.close().catch(() => undefined);
      await removeIfPresent(input.tmpPath);
      throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH);
    }
    await handle.sync();
    await handle.chmod(input.mode);
    await handle.close();
    return { digest, matched };
  } catch (error) {
    return fail(error);
  }
};

export interface InstallStreamOptions {
  /** Operator saw the digest-mismatch warning and chose to install the file anyway (upload only). */
  acceptMismatch?: boolean;
  compressed: 'auto' | 'gzip' | 'none';
  source: NetworkProxyArtifactSource;
}

const installVerifiedStream = async (
  spec: ArtifactSpec,
  stream: NodeJS.ReadableStream,
  opts: InstallStreamOptions,
): Promise<InstalledArtifact> => {
  const dataDir = resolveDataDir();
  const paths = enginePaths(dataDir);
  return withInstallLock(
    paths.lockPath,
    async () => {
      await ensureSecureDirectory(spec.destParent, { create: true, root: dataDir });
      const dest = path.join(spec.destParent, spec.destName);
      const tmpPath = `${dest}.${process.pid}.${randomUUID()}.tmp`;
      const { digest, matched } = await writeStreamToVerifiedFile({
        acceptMismatch: opts.acceptMismatch === true && opts.source === 'upload',
        compressed: opts.compressed,
        expectedSha256: spec.sha256,
        maxCompressed: NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES,
        maxDecompressed: spec.size,
        mode: spec.mode,
        stream,
        tmpPath,
      });
      await rename(tmpPath, dest);
      await chmod(dest, spec.mode);
      // The acceptance side-file must describe exactly the file now at `dest`: write it for an
      // accepted mismatch, drop any stale one when a matching file replaces an accepted one.
      if (matched) await removeIfPresent(acceptedDigestPath(dest));
      else await writeAcceptedDigest(dest, digest);
      await rememberPinnedDigest(dest, digest);
      let smokeOutput: string | null = null;
      if (spec.kind === 'engine') {
        const smoked = await smokeTestEngineBinary(dest);
        smokeOutput = smoked.smokeOutput;
        log('engine smoke test: %s', smokeOutput);
      }
      return {
        kind: spec.kind,
        path: dest,
        pinnedDigestMatch: matched,
        sha256: digest,
        smokeOutput,
        source: opts.source,
        version: spec.version,
      };
    },
    dataDir,
  );
};

const openDownloadStream = async (
  url: string,
  proxyUrl?: string | null,
): Promise<{ close: () => Promise<void>; stream: NodeJS.ReadableStream }> => {
  const origin = redactUrlForDisplay(url);
  if (proxyUrl) {
    const agent = new ProxyAgent(proxyUrl);
    const response = await undiciFetch(url, { dispatcher: agent, redirect: 'follow' });
    if (!response.ok || !response.body) {
      await agent.close().catch(() => undefined);
      throw new Error(`artifact download failed (${response.status}) from ${origin}`);
    }
    return {
      close: async () => {
        await agent.close().catch(() => undefined);
      },
      stream: Readable.fromWeb(response.body as WebReadableStream),
    };
  }
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`artifact download failed (${response.status}) from ${origin}`);
  }
  return {
    close: async () => undefined,
    stream: Readable.fromWeb(response.body as WebReadableStream),
  };
};

const resolveInstalledEngine = async (
  opts?: ResolveEngineBinaryOptions,
): Promise<InstalledArtifact | null> => {
  const override = process.env[NETWORK_PROXY_ENV.ENGINE_BIN]?.trim();
  if (override) {
    if (overrideSmoke?.path === override) {
      return {
        kind: 'engine',
        path: override,
        pinnedDigestMatch: true,
        sha256: '',
        smokeOutput: overrideSmoke.smokeOutput,
        source: 'operator_override',
        version: overrideSmoke.version,
      };
    }
    const smoked = await smokeTestEngineBinary(override);
    overrideSmoke = { path: override, smokeOutput: smoked.smokeOutput, version: smoked.version };
    log('operator override smoke test: %s', smoked.smokeOutput);
    return {
      kind: 'engine',
      path: override,
      pinnedDigestMatch: true,
      sha256: '',
      smokeOutput: smoked.smokeOutput,
      source: 'operator_override',
      version: smoked.version,
    };
  }
  let spec: ArtifactSpec;
  try {
    spec = resolveArtifactSpec('engine');
  } catch {
    return null;
  }
  const dest = path.join(spec.destParent, spec.destName);
  if (!(await isRegularFile(dest))) return null;
  const verified = await verifyPinnedFile(dest, spec.sha256, { reverify: opts?.reverify === true });
  return {
    kind: 'engine',
    path: dest,
    pinnedDigestMatch: verified.pinnedDigestMatch,
    sha256: verified.digest,
    smokeOutput: lastSmokeOutput,
    // An accepted mismatch can only come from a manual upload; a matching file may be either.
    source: verified.pinnedDigestMatch ? 'download' : 'upload',
    version: spec.version,
  };
};

const resolveInstalledGeodata = async (
  kind: 'geoip' | 'geosite',
  opts?: { reverify?: boolean },
): Promise<InstalledArtifact | null> => {
  const spec = resolveArtifactSpec(kind);
  const dest = path.join(spec.destParent, spec.destName);
  if (!(await isRegularFile(dest))) return null;
  const verified = await verifyPinnedFile(dest, spec.sha256, { reverify: opts?.reverify === true });
  return {
    kind,
    path: dest,
    pinnedDigestMatch: verified.pinnedDigestMatch,
    sha256: verified.digest,
    source: verified.pinnedDigestMatch ? 'download' : 'upload',
    version: spec.version,
  };
};

const toState = (
  kind: NetworkProxyArtifactKind,
  installed: InstalledArtifact | null,
): ArtifactState => ({
  installed: Boolean(installed),
  kind,
  ...(installed ? { pinnedDigestMatch: installed.pinnedDigestMatch } : {}),
  source: installed?.source ?? null,
  version: installed?.version ?? null,
});

export const artifactManager = {
  getInstalled: async (kind: NetworkProxyArtifactKind): Promise<InstalledArtifact | null> => {
    if (kind === 'engine') return resolveInstalledEngine();
    return resolveInstalledGeodata(kind);
  },

  getStatus: async (): Promise<ArtifactState[]> => {
    const engine = await resolveInstalledEngine().catch(() => null);
    const geoip = await resolveInstalledGeodata('geoip').catch(() => null);
    const geosite = await resolveInstalledGeodata('geosite').catch(() => null);
    return [toState('engine', engine), toState('geoip', geoip), toState('geosite', geosite)];
  },

  installFromDownload: async (
    kind: NetworkProxyArtifactKind,
    opts?: { proxyUrl?: string | null },
  ): Promise<InstalledArtifact> => {
    const spec = resolveArtifactSpec(kind);
    const download = await openDownloadStream(spec.downloadUrl, opts?.proxyUrl);
    try {
      return await installVerifiedStream(spec, download.stream, {
        compressed: spec.compressed,
        source: 'download',
      });
    } finally {
      await download.close();
    }
  },

  installFromStream: async (
    kind: NetworkProxyArtifactKind,
    stream: NodeJS.ReadableStream,
    opts: InstallStreamOptions,
  ): Promise<InstalledArtifact> => {
    const spec = resolveArtifactSpec(kind);
    return installVerifiedStream(spec, stream, opts);
  },

  resolveEngineBinary: async (
    opts?: ResolveEngineBinaryOptions,
  ): Promise<InstalledArtifact | null> => resolveInstalledEngine(opts),
};

/** Copy pinned geodata into `runtimeDir` after verifying the digest from a no-follow handle. */
export const materializeGeodataIntoRuntime = async (runtimeDir: string): Promise<boolean> => {
  const geoipSpec = resolveArtifactSpec('geoip');
  const geositeSpec = resolveArtifactSpec('geosite');
  const geoipSrc = path.join(geoipSpec.destParent, geoipSpec.destName);
  const geositeSrc = path.join(geositeSpec.destParent, geositeSpec.destName);
  if (!(await isRegularFile(geoipSrc)) || !(await isRegularFile(geositeSrc))) return false;
  await verifyPinnedFile(geoipSrc, geoipSpec.sha256);
  await verifyPinnedFile(geositeSrc, geositeSpec.sha256);
  const geoip = { path: geoipSrc };
  const geosite = { path: geositeSrc };
  const dataDir = resolveDataDir();
  await ensureSecureDirectory(runtimeDir, { create: true, root: dataDir });
  const geoipDest = path.join(runtimeDir, NETWORK_PROXY_ENGINE_MANIFEST.geodata.files.geoip.file);
  const geositeDest = path.join(
    runtimeDir,
    NETWORK_PROXY_ENGINE_MANIFEST.geodata.files.geosite.file,
  );
  await copyFile(geoip.path, geoipDest);
  await copyFile(geosite.path, geositeDest);
  await chmod(geoipDest, 0o400);
  await chmod(geositeDest, 0o400);
  return true;
};

export const geodataRuntimeReady = async (runtimeDir: string): Promise<boolean> => {
  const geoip = path.join(runtimeDir, NETWORK_PROXY_ENGINE_MANIFEST.geodata.files.geoip.file);
  const geosite = path.join(runtimeDir, NETWORK_PROXY_ENGINE_MANIFEST.geodata.files.geosite.file);
  return (await fileExists(geoip)) && (await fileExists(geosite));
};

export const installedArtifactPath = (kind: NetworkProxyArtifactKind): string | null => {
  try {
    const spec = resolveArtifactSpec(kind);
    return path.join(spec.destParent, spec.destName);
  } catch {
    return null;
  }
};

export const artifactParentDir = (kind: NetworkProxyArtifactKind): string =>
  resolveArtifactSpec(kind).destParent;

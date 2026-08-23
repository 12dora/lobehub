import { access, chmod, copyFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import debug from 'debug';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

import type { NetworkProxyArtifactKind } from '@/const/platform/networkProxy';
import { NETWORK_PROXY_ENGINE_MANIFEST, NETWORK_PROXY_ENV } from '@/const/platform/networkProxy';
import type { ArtifactState } from '@/types/platform/networkProxy';

import { writeAcceptedDigest } from './artifactAcceptedDigest';
import { resetDigestCachesForTest, verifyPinnedFile } from './artifactDigest';
import { installVerifiedStream } from './artifactInstall';
import {
  getLastEngineSmokeOutput,
  resetSmokeCachesForTest,
  smokeTestEngineBinary,
} from './artifactSmoke';
import { resolveArtifactSpec } from './artifactSpec';
import type {
  ArtifactSpec,
  InstalledArtifact,
  InstallStreamOptions,
  ResolveEngineBinaryOptions,
} from './artifactTypes';
import { redactUrlForDisplay } from './b1';
import { ensureSecureDirectory } from './fsSecure';
import { resolveDataDir } from './platform';

const log = debug('lobe-server:network-proxy-artifacts');

let overrideSmoke: { path: string; smokeOutput: string; version: string } | null = null;

export const resetArtifactCachesForTest = (): void => {
  resetDigestCachesForTest();
  resetSmokeCachesForTest();
  overrideSmoke = null;
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
  const verified = await verifyPinnedFile(dest, spec.sha256, {
    accept: { kind: 'engine', manifestVersion: spec.version },
    reverify: opts?.reverify === true,
  });
  return {
    kind: 'engine',
    path: dest,
    pinnedDigestMatch: verified.pinnedDigestMatch,
    sha256: verified.digest,
    smokeOutput: getLastEngineSmokeOutput(),
    // An accepted mismatch can only come from a manual upload; a matching file may be either.
    source: verified.pinnedDigestMatch ? 'download' : 'upload',
    version: verified.reportedVersion ?? spec.version,
  };
};

const resolveInstalledGeodata = async (
  kind: 'geoip' | 'geosite',
  opts?: { reverify?: boolean },
): Promise<InstalledArtifact | null> => {
  const spec = resolveArtifactSpec(kind);
  const dest = path.join(spec.destParent, spec.destName);
  if (!(await isRegularFile(dest))) return null;
  const verified = await verifyPinnedFile(dest, spec.sha256, {
    accept: { kind, manifestVersion: spec.version },
    reverify: opts?.reverify === true,
  });
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
      return await installVerifiedStream(
        spec,
        download.stream,
        {
          compressed: spec.compressed,
          source: 'download',
        },
        writeAcceptedDigest,
      );
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
    return installVerifiedStream(spec, stream, opts, writeAcceptedDigest);
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
  // Full rehash (not the identity cache): these bytes are about to be copied into the engine's
  // home directory, so an in-place edit that preserved size/mtime must not slip through.
  await verifyPinnedFile(geoipSrc, geoipSpec.sha256, {
    accept: { kind: 'geoip', manifestVersion: geoipSpec.version },
    reverify: true,
  });
  await verifyPinnedFile(geositeSrc, geositeSpec.sha256, {
    accept: { kind: 'geosite', manifestVersion: geositeSpec.version },
    reverify: true,
  });
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

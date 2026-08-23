import path from 'node:path';

import type {
  NetworkProxyArtifactKind,
  NetworkProxyEngineAsset,
  NetworkProxyGeodataFile,
} from '@/const/platform/networkProxy';
import { NETWORK_PROXY_ENGINE_MANIFEST, NETWORK_PROXY_ENV } from '@/const/platform/networkProxy';

import type { ArtifactSpec } from './artifactTypes';
import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';
import { detectEnginePlatform, enginePaths, resolveDataDir } from './platform';

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

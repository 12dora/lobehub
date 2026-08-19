import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';
import type {
  ArtifactState,
  ArtifactStatusView,
  NetworkProxyArtifactKind,
} from '@/types/platform/networkProxy';

/** The two files smart routing needs; they are installed and shown as one thing. */
export const GEODATA_KINDS = ['geoip', 'geosite'] as const;

export const findArtifact = (
  artifacts: ArtifactState[] | undefined,
  kind: NetworkProxyArtifactKind,
): ArtifactState | undefined => artifacts?.find((item) => item.kind === kind);

/** The digest an operator can eyeball before uploading, for every artifact kind. */
export const expectedDigest = (
  kind: NetworkProxyArtifactKind,
  artifacts: ArtifactStatusView | undefined,
): string | null =>
  kind === 'engine'
    ? (artifacts?.engine.binSha256 ?? null)
    : NETWORK_PROXY_ENGINE_MANIFEST.geodata.files[kind].sha256;

/** Official file the operator can fetch by hand when the server cannot reach the host. */
export const downloadUrl = (
  kind: NetworkProxyArtifactKind,
  artifacts: ArtifactStatusView | undefined,
): string | null => {
  if (kind === 'engine') {
    const asset =
      artifacts?.engine.expectedAsset ??
      (artifacts?.engine.platformKey
        ? NETWORK_PROXY_ENGINE_MANIFEST.assets[
            artifacts.engine.platformKey as keyof typeof NETWORK_PROXY_ENGINE_MANIFEST.assets
          ]?.asset
        : null);
    if (!asset) return null;
    return `${NETWORK_PROXY_ENGINE_MANIFEST.baseUrl}/${artifacts?.engine.version ?? NETWORK_PROXY_ENGINE_MANIFEST.version}/${asset}`;
  }
  const { baseUrl, commit, files } = NETWORK_PROXY_ENGINE_MANIFEST.geodata;
  return `${baseUrl}/${commit}/${files[kind].file}`;
};

/** gzip digest of the engine release asset — what a hand-downloaded file hashes to. */
export const expectedGzDigest = (
  kind: NetworkProxyArtifactKind,
  artifacts: ArtifactStatusView | undefined,
): string | null => {
  if (kind !== 'engine' || !artifacts?.engine.platformKey) return null;
  return (
    NETWORK_PROXY_ENGINE_MANIFEST.assets[
      artifacts.engine.platformKey as keyof typeof NETWORK_PROXY_ENGINE_MANIFEST.assets
    ]?.gzSha256 ?? null
  );
};

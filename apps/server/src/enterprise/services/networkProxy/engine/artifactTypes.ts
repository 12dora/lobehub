import type {
  NetworkProxyArtifactKind,
  NetworkProxyArtifactSource,
} from '@/const/platform/networkProxy';

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

export interface InstallStreamOptions {
  /** Operator saw the digest-mismatch warning and chose to install the file anyway (upload only). */
  acceptMismatch?: boolean;
  compressed: 'auto' | 'gzip' | 'none';
  source: NetworkProxyArtifactSource;
}

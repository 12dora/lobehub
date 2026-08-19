import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';
import type { ArtifactState, ArtifactStatusView } from '@/types/platform/networkProxy';

import { downloadUrl, expectedDigest, expectedGzDigest, findArtifact } from './engineArtifacts';

const catalog = (engine: Partial<ArtifactStatusView['engine']> = {}): ArtifactStatusView => ({
  engine: {
    binSha256: null,
    expectedAsset: null,
    platformKey: null,
    supported: true,
    version: NETWORK_PROXY_ENGINE_MANIFEST.version,
    ...engine,
  },
  geodata: { commit: NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit, files: [] },
  instances: [],
});

describe('downloadUrl', () => {
  it('uses expectedAsset for the engine when the catalogue names one', () => {
    expect(
      downloadUrl('engine', catalog({ expectedAsset: 'mihomo-custom.gz', version: 'v9.9.9' })),
    ).toBe(`${NETWORK_PROXY_ENGINE_MANIFEST.baseUrl}/v9.9.9/mihomo-custom.gz`);
  });

  it('falls back to the pinned platform asset when expectedAsset is missing', () => {
    const key = 'linux:x64' as const;
    expect(downloadUrl('engine', catalog({ platformKey: key }))).toBe(
      `${NETWORK_PROXY_ENGINE_MANIFEST.baseUrl}/${NETWORK_PROXY_ENGINE_MANIFEST.version}/${NETWORK_PROXY_ENGINE_MANIFEST.assets[key].asset}`,
    );
  });

  it('is null when the engine has neither expectedAsset nor a known platform asset', () => {
    expect(downloadUrl('engine', catalog())).toBeNull();
    expect(downloadUrl('engine', catalog({ platformKey: 'win32:x64' }))).toBeNull();
    expect(downloadUrl('engine', undefined)).toBeNull();
  });

  it('builds geodata URLs as baseUrl/commit/file, ignoring the catalogue', () => {
    const { baseUrl, commit, files } = NETWORK_PROXY_ENGINE_MANIFEST.geodata;
    expect(downloadUrl('geoip', undefined)).toBe(`${baseUrl}/${commit}/${files.geoip.file}`);
    expect(downloadUrl('geosite', catalog({ expectedAsset: 'unused.gz' }))).toBe(
      `${baseUrl}/${commit}/${files.geosite.file}`,
    );
  });
});

describe('expectedDigest', () => {
  it('is the engine binSha256 from the catalogue', () => {
    expect(expectedDigest('engine', catalog({ binSha256: 'abc123' }))).toBe('abc123');
    expect(expectedDigest('engine', catalog({ binSha256: null }))).toBeNull();
    expect(expectedDigest('engine', undefined)).toBeNull();
  });

  it('is the pinned geodata sha256 from the manifest', () => {
    expect(expectedDigest('geoip', undefined)).toBe(
      NETWORK_PROXY_ENGINE_MANIFEST.geodata.files.geoip.sha256,
    );
    expect(expectedDigest('geosite', catalog({ binSha256: 'not-this' }))).toBe(
      NETWORK_PROXY_ENGINE_MANIFEST.geodata.files.geosite.sha256,
    );
  });
});

describe('expectedGzDigest', () => {
  it('reads the engine gzip digest from the pinned platform asset', () => {
    const key = 'darwin:arm64' as const;
    expect(expectedGzDigest('engine', catalog({ platformKey: key }))).toBe(
      NETWORK_PROXY_ENGINE_MANIFEST.assets[key].gzSha256,
    );
  });

  it('is null for geodata kinds and when the engine platform is unknown', () => {
    expect(expectedGzDigest('geoip', catalog({ platformKey: 'linux:x64' }))).toBeNull();
    expect(expectedGzDigest('geosite', catalog({ platformKey: 'linux:x64' }))).toBeNull();
    expect(expectedGzDigest('engine', catalog())).toBeNull();
    expect(expectedGzDigest('engine', catalog({ platformKey: 'win32:x64' }))).toBeNull();
    expect(expectedGzDigest('engine', undefined)).toBeNull();
  });
});

describe('findArtifact', () => {
  const engine: ArtifactState = {
    installed: true,
    kind: 'engine',
    source: 'download',
    version: 'v1.19.30',
  };

  it('returns the matching kind, or undefined', () => {
    expect(findArtifact([engine], 'engine')).toEqual(engine);
    expect(findArtifact([engine], 'geoip')).toBeUndefined();
    expect(findArtifact(undefined, 'engine')).toBeUndefined();
  });
});

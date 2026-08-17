import type { ArtifactState, InstanceStatusView } from '@/types/platform/networkProxy';

import { deriveGeodataState } from './geodataState';

const artifact = (kind: ArtifactState['kind'], installed: boolean): ArtifactState => ({
  installed,
  kind,
  source: installed ? 'download' : null,
  version: installed ? 'v1' : null,
});

const instance = (artifacts: ArtifactState[]): InstanceStatusView =>
  ({ artifacts }) as unknown as InstanceStatusView;

describe('deriveGeodataState', () => {
  it('is ready only when both rule files are installed', () => {
    expect(deriveGeodataState(instance([artifact('geoip', true), artifact('geosite', true)]))).toBe(
      'ready',
    );
  });

  it('is missing when one of them is absent', () => {
    expect(
      deriveGeodataState(instance([artifact('geoip', true), artifact('geosite', false)])),
    ).toBe('missing');
    expect(deriveGeodataState(instance([artifact('engine', true)]))).toBe('missing');
  });

  it('is unknown — not missing — when no instance has reported', () => {
    // The distinction is the whole point: "we did not read it" must never render as "empty disk".
    expect(deriveGeodataState(undefined)).toBe('unknown');
  });
});

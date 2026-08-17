// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';

import {
  aggregateGeodataLocal,
  geodataInstallAfterDiff,
  mergeDesiredGeodataPatch,
  NETWORK_PROXY_GEODATA_KINDS,
} from './networkProxyGeodata';

describe('mergeDesiredGeodataPatch', () => {
  it('merges geoip and geosite desired-state patches at the pinned commit', () => {
    const patch = mergeDesiredGeodataPatch('2026-08-17T00:00:00.000Z');
    expect(NETWORK_PROXY_GEODATA_KINDS).toEqual(['geoip', 'geosite']);
    expect(patch.geoip).toEqual({
      commit: NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit,
      requestedAt: '2026-08-17T00:00:00.000Z',
    });
    expect(patch.geosite).toEqual({
      commit: NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit,
      requestedAt: '2026-08-17T00:00:00.000Z',
    });
    expect(patch.engine).toBeUndefined();
  });
});

describe('geodataInstallAfterDiff', () => {
  it('records both kinds, the pinned commit, and download source', () => {
    expect(geodataInstallAfterDiff(4)).toEqual({
      commit: NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit,
      kinds: ['geoip', 'geosite'],
      revision: 4,
      source: 'download',
    });
  });
});

describe('aggregateGeodataLocal', () => {
  it('is ok only when every kind succeeded', () => {
    expect(
      aggregateGeodataLocal([
        { error: null, kind: 'geoip', ok: true },
        { error: null, kind: 'geosite', ok: true },
      ]),
    ).toEqual({ error: null, ok: true });
  });

  it('uses the first non-null error as the aggregate', () => {
    expect(
      aggregateGeodataLocal([
        { error: 'geodata_missing', kind: 'geoip', ok: false },
        { error: 'unknown', kind: 'geosite', ok: false },
      ]),
    ).toEqual({ error: 'geodata_missing', ok: false });
  });
});

import { describe, expect, it } from 'vitest';

import {
  featureEgressScope,
  NETWORK_PROXY_ENGINE_MANIFEST,
  NETWORK_PROXY_ENGINE_PLATFORM_KEYS,
  parseEgressScopeId,
  providerEgressScope,
  resolveEnginePlatformKey,
} from './networkProxy';

describe('networkProxy const', () => {
  it('builds and parses scope ids', () => {
    expect(providerEgressScope('openai')).toBe('provider:openai');
    expect(featureEgressScope('market')).toBe('feature:market');
    expect(parseEgressScopeId('provider:openai')).toEqual({ id: 'openai', kind: 'provider' });
    expect(parseEgressScopeId('feature:web_search')).toEqual({ id: 'web_search', kind: 'feature' });
    expect(parseEgressScopeId('feature:nope')).toBeNull();
    expect(parseEgressScopeId('provider:')).toBeNull();
    expect(parseEgressScopeId('user:1')).toBeNull();
  });

  it('pins one engine version with complete per-platform digests', () => {
    expect(NETWORK_PROXY_ENGINE_MANIFEST.version).toMatch(/^v\d+\.\d+\.\d+$/);
    for (const key of NETWORK_PROXY_ENGINE_PLATFORM_KEYS) {
      const asset = NETWORK_PROXY_ENGINE_MANIFEST.assets[key];
      expect(asset.asset).toContain(NETWORK_PROXY_ENGINE_MANIFEST.version);
      expect(asset.gzSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.binSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.binSize).toBeGreaterThan(10_000_000);
    }
    for (const file of Object.values(NETWORK_PROXY_ENGINE_MANIFEST.geodata.files)) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.size).toBeGreaterThan(1_000_000);
    }
    expect(NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit).toMatch(/^[a-f0-9]{40}$/);
  });

  it('only supports linux x64/arm64 and darwin arm64', () => {
    expect(resolveEnginePlatformKey('linux', 'x64')).toBe('linux:x64');
    expect(resolveEnginePlatformKey('linux', 'arm64')).toBe('linux:arm64');
    expect(resolveEnginePlatformKey('darwin', 'arm64')).toBe('darwin:arm64');
    expect(resolveEnginePlatformKey('darwin', 'x64')).toBeNull();
    expect(resolveEnginePlatformKey('linux', 'arm')).toBeNull();
    expect(resolveEnginePlatformKey('win32', 'x64')).toBeNull();
  });
});

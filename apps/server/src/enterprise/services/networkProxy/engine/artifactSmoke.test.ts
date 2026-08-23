// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseMihomoVersion } from './artifactSmoke';

describe('parseMihomoVersion', () => {
  it('keeps a leading v', () => {
    expect(parseMihomoVersion('Mihomo Meta v1.19.30 test build')).toBe('v1.19.30');
  });

  it('prefixes a bare semver with v', () => {
    expect(parseMihomoVersion('mihomo 1.19.30 linux amd64')).toBe('v1.19.30');
  });

  it('returns null when no semver is present', () => {
    expect(parseMihomoVersion('not a version string')).toBeNull();
  });
});

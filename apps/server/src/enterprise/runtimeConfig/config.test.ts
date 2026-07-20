// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { getPlatformConfigCacheTtlMs, PLATFORM_CONFIG_CACHE_TTL_BOUNDS } from './config';

describe('runtime config cache TTL', () => {
  it('defaults to 30 seconds without reading env at module import', () => {
    expect(getPlatformConfigCacheTtlMs({})).toBe(30_000);
  });

  it('accepts exact bounds and clamps values outside them', () => {
    expect(
      getPlatformConfigCacheTtlMs({ PLATFORM_CONFIG_CACHE_TTL_SECONDS: '1' }),
    ).toBe(1000);
    expect(
      getPlatformConfigCacheTtlMs({
        PLATFORM_CONFIG_CACHE_TTL_SECONDS: String(
          PLATFORM_CONFIG_CACHE_TTL_BOUNDS.maxSeconds,
        ),
      }),
    ).toBe(300_000);
    expect(
      getPlatformConfigCacheTtlMs({ PLATFORM_CONFIG_CACHE_TTL_SECONDS: '0' }),
    ).toBe(1000);
    expect(
      getPlatformConfigCacheTtlMs({ PLATFORM_CONFIG_CACHE_TTL_SECONDS: '999999' }),
    ).toBe(300_000);
  });

  it.each(['', '1.5', '1e2', '-1', 'not-a-number'])(
    'falls back for malformed value %j',
    (value) => {
      expect(
        getPlatformConfigCacheTtlMs({ PLATFORM_CONFIG_CACHE_TTL_SECONDS: value }),
      ).toBe(30_000);
    },
  );
});

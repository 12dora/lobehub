// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLATFORM_SETTING_CONTROL_WIRING } from './controlWiring';

/**
 * Supported user-control subset of the server registry (must stay in sync with
 * paths that have real settings UI + PlatformSettingSourceBadge wiring).
 */
const SUPPORTED_USER_CONTROL_PATHS = new Set(PLATFORM_SETTING_CONTROL_WIRING.map((w) => w.path));

describe('platform setting control wiring', () => {
  it('every wired surface imports PlatformSettingSourceBadge / usePlatformSettingMeta', () => {
    // __dirname = src/features/PlatformSettingSourceBadge → repo root is 3 levels up
    const root = path.join(__dirname, '../../..');
    for (const entry of PLATFORM_SETTING_CONTROL_WIRING) {
      const full = path.join(root, entry.surfaceFile);
      const text = readFileSync(full, 'utf8');
      expect(text, entry.surfaceFile).toMatch(/PlatformSettingSourceBadge/);
      expect(text, entry.surfaceFile).toMatch(/usePlatformSettingMeta/);
      expect(text, entry.surfaceFile).toContain(entry.path);
    }
  });

  it('supported paths are finite and non-empty', () => {
    expect(SUPPORTED_USER_CONTROL_PATHS.size).toBeGreaterThan(0);
  });
});

// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { settingsRegistry } from '@/server/enterprise/services/settings/registry';

import {
  PLATFORM_SETTING_CONTROL_SURFACES,
  REGISTRY_PATHS_WITHOUT_USER_CONTROL,
} from './controlWiring';

describe('platform setting control wiring (U3-R2)', () => {
  it('every registry path is either wired to a surface or explicitly without control', () => {
    const wired = new Set<string>(PLATFORM_SETTING_CONTROL_SURFACES.map((s) => s.path));
    const intentional = new Set<string>(REGISTRY_PATHS_WITHOUT_USER_CONTROL);
    const registryPaths = settingsRegistry.paths() as readonly string[];

    for (const p of registryPaths) {
      const covered = wired.has(p) || intentional.has(p);
      expect(covered, `Registry path ${p} missing control surface mapping`).toBe(true);
    }

    // No stale intentional entries for removed paths
    const registrySet = new Set(registryPaths);
    for (const p of intentional) {
      expect(registrySet.has(p), `Stale intentional path ${p}`).toBe(true);
    }
  });

  it('every wired surface imports managed metadata and references its path', () => {
    const root = path.join(__dirname, '../../..');
    for (const entry of PLATFORM_SETTING_CONTROL_SURFACES) {
      const full = path.join(root, entry.surfaceFile);
      const text = readFileSync(full, 'utf8');
      expect(text, entry.surfaceFile).toMatch(
        /usePlatformSettingMeta|ManagedSettingField|PlatformSettingSourceBadge/,
      );
      expect(text, entry.surfaceFile).toContain(entry.path);
    }
  });
});

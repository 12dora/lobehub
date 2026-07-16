// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SETTINGS_USER_CONTROL_SURFACE_COVERAGE } from '@/server/enterprise/services/settings/registry';

describe('platform setting control wiring (R3-U3)', () => {
  it('derives every declaration from canonical registry metadata', () => {
    expect(SETTINGS_USER_CONTROL_SURFACE_COVERAGE.length).toBeGreaterThan(0);
    expect(new Set(SETTINGS_USER_CONTROL_SURFACE_COVERAGE.map(({ path: p }) => p)).size).toBe(
      SETTINGS_USER_CONTROL_SURFACE_COVERAGE.length,
    );

    for (const {
      path: settingPath,
      userControlSurface,
    } of SETTINGS_USER_CONTROL_SURFACE_COVERAGE) {
      if (userControlSurface.kind === 'none') {
        expect(userControlSurface.reason, settingPath).not.toMatch(
          /complex|nested|not (?:exposed|managed|wired)/i,
        );
      }
    }
  });

  it('every wired surface imports managed wrappers and references path', () => {
    const root = path.join(__dirname, '../../..');
    const surfaces = SETTINGS_USER_CONTROL_SURFACE_COVERAGE.filter(
      (entry) => entry.userControlSurface.kind === 'surface',
    );

    for (const { path: settingPath, userControlSurface } of surfaces) {
      if (userControlSurface.kind !== 'surface') throw new Error('unreachable');

      const full = path.join(root, userControlSurface.surfaceFile);
      const text = readFileSync(full, 'utf8');
      expect(text, userControlSurface.surfaceFile).toMatch(
        /usePlatformSettingMeta|ManagedCompositeSettingFieldContent|ManagedFormControlContent|ManagedSettingFieldContent|PlatformSettingSourceBadge/,
      );
      expect(text, userControlSurface.surfaceFile).toContain(settingPath);
    }
  });
});

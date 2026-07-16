// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { LobeChatDatabase } from '@/database/type';

import {
  loadEffectiveUserSettings,
  SETTINGS_RUNTIME_READ_REGISTRY,
} from './runtimeSettingsAdapter';

vi.mock('../../featureFlags', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getDefaultEnterpriseFeatureFlags: () => Record<string, boolean>;
  };
  return {
    ...actual,
    getEnterpriseFeatureFlags: () => ({
      ...actual.getDefaultEnterpriseFeatureFlags(),
      ENABLE_PLATFORM_SETTINGS_POLICY: false,
    }),
  };
});

describe('runtimeSettingsAdapter', () => {
  it('flag OFF preserves legacy settings including keyVaults', async () => {
    const db = (await getTestDB()) as LobeChatDatabase;
    const { settings, effective } = await loadEffectiveUserSettings({
      db,
      legacySettings: {
        general: { fontSize: 17 },
        keyVaults: { openai: { apiKey: 'sk-test' } },
      },
      userId: 'u-runtime',
    });

    expect(settings.keyVaults).toEqual({ openai: { apiKey: 'sk-test' } });
    expect(effective.pathMeta['keyVaults']).toBeUndefined();
    expect(effective.platformRevision).toBe(0);
  });

  it('registry lists known runtime read entry points', () => {
    expect(SETTINGS_RUNTIME_READ_REGISTRY).toContain('userRouter.getUserState');
    expect(SETTINGS_RUNTIME_READ_REGISTRY).toContain(
      'runtimeSettingsAdapter.loadEffectiveUserSettings',
    );
  });

  /**
   * Static registration test: any new apps/server file that reads user settings
   * via getUserState().settings and also touches defaultAgent/systemAgent/tool
   * without importing the runtime adapter is flagged.
   *
   * This is intentionally narrow — does not rewrite all unrelated code.
   */
  it('catches new registered-style runtime reads that bypass the adapter', () => {
    const serverRoot = join(process.cwd(), 'apps/server/src');
    // When running from monorepo root or package, resolve both
    const candidates = [serverRoot, join(process.cwd(), 'src'), join(__dirname, '../../../..')];

    let root = serverRoot;
    for (const c of candidates) {
      try {
        if (statSync(c).isDirectory()) {
          root = c;
          break;
        }
      } catch {
        /* try next */
      }
    }

    // Prefer absolute monorepo path
    const monoServer = join(__dirname, '../../../../../../apps/server/src');
    try {
      if (statSync(monoServer).isDirectory()) root = monoServer;
    } catch {
      /* keep root */
    }

    const offenders: string[] = [];
    const adapterMarker = 'runtimeSettingsAdapter';
    const allowlist = new Set([
      // This adapter itself and its tests
      'enterprise/services/settings/runtimeSettingsAdapter.ts',
      'enterprise/services/settings/runtimeSettingsAdapter.test.ts',
      'enterprise/services/settings/effectiveSettingsService.ts',
      'enterprise/services/settings/effectiveSettingsService.test.ts',
      // user router is the mount point and must import the adapter
      'routers/lambda/user.ts',
    ]);

    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === 'node_modules' || name === 'dist') continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;

        let text: string;
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }

        // Narrow heuristic: reads getUserState and then accesses settings for
        // defaultAgent / systemAgent / tool without importing the adapter.
        const touchesAgentSettings =
          /settings\s*\.\s*defaultAgent|settings\s*\.\s*systemAgent|settings\s*\.\s*tool/.test(
            text,
          );
        const callsGetUserState = /getUserState\s*\(/.test(text);
        if (!touchesAgentSettings || !callsGetUserState) continue;

        if (text.includes(adapterMarker)) continue;

        const rel = relative(root, full).replaceAll('\\', '/');
        if ([...allowlist].some((a) => rel.endsWith(a))) continue;

        // Only flag files under enterprise or routers that look like new runtime reads
        if (!rel.includes('enterprise') && !rel.includes('routers') && !rel.includes('services')) {
          continue;
        }

        offenders.push(rel);
      }
    };

    walk(root);

    expect(
      offenders,
      `New server-side settings reads must import runtimeSettingsAdapter. Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

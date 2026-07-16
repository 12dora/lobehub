// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

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
  it('flag OFF preserves sparse legacy settings including keyVaults (exact parity)', async () => {
    const db = (await getTestDB()) as LobeChatDatabase;
    const legacy = {
      general: { fontSize: 17 },
      keyVaults: { openai: { apiKey: 'sk-test' } },
    };
    const { settings, effective } = await loadEffectiveUserSettings({
      db,
      legacySettings: legacy,
      userId: 'u-runtime',
    });

    expect(settings).toEqual(legacy);
    expect(effective.platformRevision).toBe(0);
    expect(Object.keys(effective.pathMeta)).toHaveLength(0);
  });

  it('registry lists known runtime read entry points', () => {
    expect(SETTINGS_RUNTIME_READ_REGISTRY).toContain('userRouter.getUserState');
    expect(SETTINGS_RUNTIME_READ_REGISTRY).toContain(
      'runtimeSettingsAdapter.getEffectiveDefaultAgentConfig',
    );
    expect(SETTINGS_RUNTIME_READ_REGISTRY).toContain('AgentService.getAgentConfig');
  });

  it('catches direct defaultAgent/systemAgent raw settings bypasses', () => {
    const monoServer = path.join(__dirname, '../../../../../../apps/server/src');
    let root = monoServer;
    try {
      if (!statSync(monoServer).isDirectory()) {
        root = path.join(process.cwd(), 'apps/server/src');
      }
    } catch {
      root = path.join(process.cwd(), 'apps/server/src');
    }

    const allowlist = [
      'enterprise/services/settings/runtimeSettingsAdapter.ts',
      'enterprise/services/settings/runtimeSettingsAdapter.test.ts',
      'enterprise/services/settings/effectiveSettingsService.ts',
      'enterprise/services/settings/effectiveSettingsService.test.ts',
      // UserModel itself owns the raw columns
      'models/user.ts',
    ];

    const offenders: string[] = [];

    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === 'node_modules' || name === 'dist') continue;
        const full = path.join(dir, name);
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

        const rel = path.relative(root, full).replaceAll('\\', '/');
        if (allowlist.some((a) => rel.endsWith(a))) continue;

        const usesDefaultAgentBypass =
          /\.getUserSettingsDefaultAgentConfig\s*\(/.test(text) &&
          !text.includes('getEffectiveDefaultAgentConfig');
        // Property access / destructure of systemAgent from settings (not class name imports)
        const usesSystemAgentBypass =
          (/\.getUserSettings\s*\(/.test(text) || /getUserSettings\s*\(/.test(text)) &&
          (/settings\?\.systemAgent|settings\.systemAgent|systemAgent\s*=\s*settings/.test(text) ||
            /systemAgent\s+as\s+Partial/.test(text)) &&
          !text.includes('getEffectiveSystemAgentConfig') &&
          !text.includes('runtimeSettingsAdapter');

        if (usesDefaultAgentBypass || usesSystemAgentBypass) {
          offenders.push(rel);
        }
      }
    };

    walk(root);

    expect(
      offenders,
      `Runtime settings bypasses must use runtimeSettingsAdapter. Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

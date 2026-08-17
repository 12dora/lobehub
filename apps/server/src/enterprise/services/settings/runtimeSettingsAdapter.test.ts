// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { getRawUserSettings, loadEffectiveUserSettings } from './runtimeSettingsAdapter';

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

const getUserSettings = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/user', () => ({
  UserModel: class {
    getUserSettings = getUserSettings;
  },
}));

describe('runtimeSettingsAdapter', () => {
  it('dedupes getUserSettings only inside one execAgent memo slot', async () => {
    const row = { general: { timezone: 'Asia/Shanghai' }, memory: { enabled: true } };
    getUserSettings.mockReset().mockResolvedValue(row);
    const db = {} as LobeChatDatabase;
    const memo = {};

    const first = await getRawUserSettings({ db, memo, userId: 'u-memo' });
    const second = await getRawUserSettings({ db, memo, userId: 'u-memo' });

    expect(second).toBe(first);
    expect(first).toEqual(row);
    expect(getUserSettings).toHaveBeenCalledTimes(1);
  });

  it('sees an update between two separate calls without a memo', async () => {
    const db = {} as LobeChatDatabase;
    getUserSettings
      .mockReset()
      .mockResolvedValueOnce({ general: { timezone: 'UTC' } })
      .mockResolvedValueOnce({ general: { timezone: 'Asia/Shanghai' } });

    const before = await getRawUserSettings({ db, userId: 'u-update' });
    const after = await getRawUserSettings({ db, userId: 'u-update' });

    expect(before).toEqual({ general: { timezone: 'UTC' } });
    expect(after).toEqual({ general: { timezone: 'Asia/Shanghai' } });
    expect(getUserSettings).toHaveBeenCalledTimes(2);
  });

  it('flag OFF preserves sparse legacy settings including keyVaults (exact parity)', async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('database accessed while feature flag is off');
        },
      },
    ) as LobeChatDatabase;
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

  it('catches direct defaultAgent/systemAgent/tool/memory raw settings bypasses', () => {
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
        const usesToolOrMemoryBypass =
          ((/\.getUserSettings\s*\(/.test(text) || /getUserSettings\s*\(/.test(text)) &&
            (/settings\?\.(?:memory|tool)|settings\.(?:memory|tool)/.test(text) ||
              /(?:memory|tool)\s*=\s*settings/.test(text))) ||
          (/query\.userSettings\.findFirst\s*\(/.test(text) &&
            /columns:\s*\{\s*(?:memory|tool):\s*true/.test(text));

        if (usesDefaultAgentBypass || usesSystemAgentBypass || usesToolOrMemoryBypass) {
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

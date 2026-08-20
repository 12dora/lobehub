// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import {
  getEffectiveSystemAgentConfig,
  getRawUserSettings,
  isSettingsPolicyEnabled,
  loadEffectiveUserSettings,
} from './runtimeSettingsAdapter';

const { policyState, isModuleEnabled } = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(async (_id: string) => true),
  policyState: { enabled: false },
}));

vi.mock('../../featureFlags', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getDefaultEnterpriseFeatureFlags: () => Record<string, boolean>;
  };
  return {
    ...actual,
    getEnterpriseFeatureFlags: () => ({
      ...actual.getDefaultEnterpriseFeatureFlags(),
      ENABLE_PLATFORM_SETTINGS_POLICY: policyState.enabled,
    }),
  };
});

vi.mock('../moduleSettings', () => ({
  isModuleEnabled: (id: string) => isModuleEnabled(id),
}));

const getUserSettings = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/user', () => ({
  UserModel: class {
    getUserSettings = getUserSettings;
  },
}));

describe('runtimeSettingsAdapter', () => {
  beforeEach(() => {
    policyState.enabled = false;
    isModuleEnabled.mockReset().mockResolvedValue(true);
    getUserSettings.mockReset();
  });

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

  it('treats env-on / module-off as policy off (same predicate as withModule)', async () => {
    policyState.enabled = true;
    isModuleEnabled.mockResolvedValue(false);

    expect(await isSettingsPolicyEnabled()).toBe(false);
    expect(isModuleEnabled).toHaveBeenCalledWith('settingsPolicy');

    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('platform tables accessed while settingsPolicy module is off');
        },
      },
    ) as LobeChatDatabase;
    const rawSystemAgent = { translation: { model: 'raw-model', provider: 'openai' } };
    getUserSettings.mockResolvedValue({ systemAgent: rawSystemAgent });

    await expect(getEffectiveSystemAgentConfig({ db, userId: 'u-module-off' })).resolves.toEqual(
      rawSystemAgent,
    );
    expect(getUserSettings).toHaveBeenCalled();
  });

  it('is on only when the env flag and settingsPolicy module are both on', async () => {
    policyState.enabled = true;
    isModuleEnabled.mockResolvedValue(true);

    expect(await isSettingsPolicyEnabled()).toBe(true);
    expect(isModuleEnabled).toHaveBeenCalledWith('settingsPolicy');
  });

  it('does not consult module state when the env flag is off', async () => {
    policyState.enabled = false;
    isModuleEnabled.mockResolvedValue(true);

    expect(await isSettingsPolicyEnabled()).toBe(false);
    expect(isModuleEnabled).not.toHaveBeenCalled();
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

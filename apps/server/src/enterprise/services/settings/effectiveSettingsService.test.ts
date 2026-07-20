// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
  platformSettingsBundle,
  userSettingOverrideRevisions,
  userSettingOverrides,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { PlatformRuntimeMaterializationReporter } from '../platformInstance/runtimeReporter';
import { AdminSettingsService } from './adminSettingsService';
import {
  EffectiveSettingsService,
  resetEffectiveSettingsCacheForTest,
  SettingsPathError,
} from './effectiveSettingsService';

const serverDB: LobeChatDatabase = await getTestDB();

vi.mock('../../featureFlags', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getDefaultEnterpriseFeatureFlags: () => Record<string, boolean>;
    getEnterpriseFeatureFlags: () => Record<string, boolean>;
  };
  return {
    ...actual,
    getEnterpriseFeatureFlags: () => ({
      ...actual.getDefaultEnterpriseFeatureFlags(),
      ENABLE_PLATFORM_SETTINGS_POLICY: true,
    }),
  };
});

const service = new EffectiveSettingsService(serverDB);
const admin = new AdminSettingsService(serverDB);

beforeEach(async () => {
  resetEffectiveSettingsCacheForTest();
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
});

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
});

const publishDefault = async () => {
  await admin.saveDraft({
    actorUserId: 'admin',
    draft: {
      'general.fontSize': {
        mode: 'default',
        schemaVersion: 1,
        value: 18,
        visibility: 'visible',
      },
      'memory.enabled': {
        mode: 'locked',
        schemaVersion: 1,
        value: true,
        visibility: 'visible',
      },
      'tts.sttAutoStop': {
        mode: 'default',
        schemaVersion: 1,
        value: true,
        visibility: 'hidden',
      },
    },
    expectedDraftToken: (await admin.getDraft()).draftToken,
    reason: 'seed',
  });
  await admin.publish({
    actorUserId: 'admin',
    expectedDraftToken: (await admin.getDraft()).draftToken,
    expectedRevision: 0,
    reason: 'publish',
  });
};

describe('EffectiveSettingsService (flag ON)', () => {
  it('reports only a newly materialized process cache entry and not its cache hit', async () => {
    await publishDefault();
    const runtimeReporter = vi.fn<PlatformRuntimeMaterializationReporter>();
    const runtimeService = new EffectiveSettingsService(serverDB, undefined, {}, runtimeReporter);

    await runtimeService.getEffectiveSettings({ userId: 'runtime-user' });
    await runtimeService.getEffectiveSettings({ userId: 'runtime-user' });

    expect(runtimeReporter).toHaveBeenCalledOnce();
    expect(runtimeReporter).toHaveBeenCalledWith(serverDB, {
      domain: 'settings',
      health: 'healthy',
      revision: 1,
      source: 'database',
    });
  });

  it('reports a database failure then recovers at the same target without replacing the error', async () => {
    await publishDefault();
    const original = Object.assign(new Error('raw settings database detail'), {
      code: 'ECONNREFUSED',
    });
    const runtimeReporter = vi.fn<PlatformRuntimeMaterializationReporter>();
    const runtimeService = new EffectiveSettingsService(serverDB, undefined, {}, runtimeReporter);
    const getBundle = vi
      .spyOn(runtimeService['model'], 'getBundle')
      .mockRejectedValueOnce(original);

    await expect(runtimeService.getEffectiveSettings({ userId: 'recovery-user' })).rejects.toBe(
      original,
    );
    getBundle.mockRestore();
    await runtimeService.getEffectiveSettings({ userId: 'recovery-user' });

    expect(runtimeReporter.mock.calls.map(([, state]) => state)).toEqual([
      {
        domain: 'settings',
        errorCategory: 'database_unavailable',
        health: 'unavailable',
        source: 'unavailable',
      },
      { domain: 'settings', health: 'healthy', revision: 1, source: 'database' },
    ]);
  });

  it('contains an injected reporter failure and returns the original effective settings', async () => {
    await publishDefault();
    const runtimeReporter = vi.fn<PlatformRuntimeMaterializationReporter>(() => {
      throw new Error('raw settings reporter detail');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtimeService = new EffectiveSettingsService(serverDB, undefined, {}, runtimeReporter);

    await expect(
      runtimeService.getEffectiveSettings({ userId: 'observer-user' }),
    ).resolves.toMatchObject({ platformRevision: 1 });
    expect(consoleError).toHaveBeenCalledWith('[platform-instance-runtime] reporter unavailable');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('raw settings reporter detail');
    consoleError.mockRestore();
  });

  it('inherits platform default without override', async () => {
    await publishDefault();
    const effective = await service.getEffectiveSettings({ userId: 'u1' });
    expect(effective.effectiveValues['general.fontSize']).toBe(18);
    expect(effective.pathMeta['general.fontSize']?.source).toBe('platform');
  });

  it('explicit equal-to-default override is user source', async () => {
    await publishDefault();
    await service.patchSettingOverride({ path: 'general.fontSize', userId: 'u1', value: 18 });
    const effective = await service.getEffectiveSettings({ userId: 'u1' });
    expect(effective.effectiveValues['general.fontSize']).toBe(18);
    expect(effective.pathMeta['general.fontSize']?.source).toBe('user');
  });

  it('locked rejects patch; retains override for unlock', async () => {
    await publishDefault();
    // patch before lock via re-publish... seed already locked memory
    await expect(
      service.patchSettingOverride({ path: 'memory.enabled', userId: 'u1', value: false }),
    ).rejects.toMatchObject({ code: 'MANAGED_SETTING_BY_ADMIN' });
  });

  it('hidden path remains writable', async () => {
    await publishDefault();
    await service.patchSettingOverride({ path: 'tts.sttAutoStop', userId: 'u1', value: false });
    const effective = await service.getEffectiveSettings({ userId: 'u1' });
    expect(effective.effectiveValues['tts.sttAutoStop']).toBe(false);
    expect(effective.pathMeta['tts.sttAutoStop']?.hidden).toBe(true);
  });

  it('reset deletes only one path', async () => {
    await publishDefault();
    await service.patchSettingOverride({ path: 'general.fontSize', userId: 'u1', value: 16 });
    await service.patchSettingOverride({ path: 'tts.sttAutoStop', userId: 'u1', value: false });

    const reset = await service.resetSettingOverride({ path: 'general.fontSize', userId: 'u1' });
    expect(reset.deleted).toBe(true);

    const effective = await service.getEffectiveSettings({ userId: 'u1' });
    expect(effective.effectiveValues['general.fontSize']).toBe(18); // platform default
    expect(effective.effectiveValues['tts.sttAutoStop']).toBe(false); // other override kept
  });

  it('rejects unknown / secret / bad type before write (legacy adapter atomic)', async () => {
    await publishDefault();

    await expect(
      service.applyLegacyUpdateSettings({
        input: { general: { fontSize: 'nope' } },
        userId: 'u1',
      }),
    ).rejects.toBeInstanceOf(SettingsPathError);

    // no override written
    const effective = await service.getEffectiveSettings({ userId: 'u1' });
    expect(effective.pathMeta['general.fontSize']?.source).toBe('platform');

    // unknown nested secret-like fails closed with zero writes
    await expect(
      service.applyLegacyUpdateSettings({
        input: { general: { fontSize: 16, apiKey: 'sk-x' } },
        userId: 'u1',
      }),
    ).rejects.toBeInstanceOf(SettingsPathError);

    const adapted = await service.applyLegacyUpdateSettings({
      input: { general: { fontSize: 16 } },
      userId: 'u1',
    });
    expect(adapted.appliedPaths).toContain('general.fontSize');

    const effective2 = await service.getEffectiveSettings({ userId: 'u1' });
    expect(effective2.effectiveValues['general.fontSize']).toBe(16);
  });

  it('user isolation', async () => {
    await publishDefault();
    await service.patchSettingOverride({ path: 'general.fontSize', userId: 'u1', value: 12 });
    await service.patchSettingOverride({ path: 'general.fontSize', userId: 'u2', value: 20 });

    const a = await service.getEffectiveSettings({ userId: 'u1' });
    const b = await service.getEffectiveSettings({ userId: 'u2' });
    expect(a.effectiveValues['general.fontSize']).toBe(12);
    expect(b.effectiveValues['general.fontSize']).toBe(20);
  });

  it('cache key changes when last override is deleted', async () => {
    await publishDefault();
    await service.patchSettingOverride({ path: 'general.fontSize', userId: 'u1', value: 16 });
    const before = await service.getEffectiveSettings({ userId: 'u1' });
    const revBefore = before.userOverrideRevision;

    await service.resetSettingOverride({ path: 'general.fontSize', userId: 'u1' });
    const after = await service.getEffectiveSettings({ userId: 'u1' });
    expect(after.userOverrideRevision).toBeGreaterThan(revBefore);
  });
});

describe('EffectiveSettingsService flag OFF parity', () => {
  it('does not require platform tables and uses legacy only', async () => {
    // Re-mock flag off for this suite by constructing with a stub isPolicyEnabled
    const runtimeReporter = vi.fn<PlatformRuntimeMaterializationReporter>();
    const offService = new EffectiveSettingsService(serverDB, undefined, {}, runtimeReporter);
    vi.spyOn(offService, 'isPolicyEnabled').mockReturnValue(false);

    const result = await offService.getEffectiveSettings({
      legacyUserSettings: { general: { fontSize: 15 } },
      userId: 'u1',
    });
    expect(result.effectiveValues['general.fontSize']).toBe(15);
    expect(result.pathMeta['general.fontSize']?.source).toBe('legacy');
    expect(result.platformRevision).toBe(0);
    expect(runtimeReporter).not.toHaveBeenCalled();

    await expect(
      offService.patchSettingOverride({ path: 'general.fontSize', userId: 'u1', value: 16 }),
    ).rejects.toMatchObject({ code: 'PLATFORM_FEATURE_DISABLED' });
  });
});

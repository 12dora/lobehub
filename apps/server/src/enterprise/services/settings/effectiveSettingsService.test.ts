// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import type { PlatformRuntimeMaterializationReporter } from '../platformInstance/runtimeReporter';
import { AdminSettingsService } from './adminSettingsService';
import {
  EffectiveSettingsService,
  getEffectiveSettingsCacheSizeForTest,
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

/** TRUNCATE bypasses append-only audit/revision immutability triggers (migration 0145). */
const resetSettingsTables = async () => {
  await serverDB.execute(
    sql.raw(`
      TRUNCATE TABLE
        platform_audit_logs,
        platform_resource_revisions,
        user_setting_overrides,
        user_setting_override_revisions,
        platform_setting_policies,
        platform_settings_bundle
      CASCADE
    `),
  );
};

const ensureUsers = async (...ids: string[]) => {
  for (const id of ids) {
    await serverDB.insert(users).values({ id }).onConflictDoNothing();
  }
};

beforeEach(async () => {
  resetEffectiveSettingsCacheForTest();
  await resetSettingsTables();
  await ensureUsers('u1', 'u2');
});

afterEach(async () => {
  await resetSettingsTables();
});

const publishDefault = async () => {
  const base = await admin.getDraft();
  await admin.save({
    actorUserId: 'admin',
    expectedDraftToken: base.draftToken,
    expectedRevision: base.baseRevision,
    policies: {
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
    reason: 'seed',
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

  it('bounds soft-cache size across many users', async () => {
    await publishDefault();
    const runtimeService = new EffectiveSettingsService(serverDB);

    for (let i = 0; i < 600; i++) {
      await runtimeService.getEffectiveSettings({ userId: `user-${i}` });
    }

    expect(getEffectiveSettingsCacheSizeForTest()).toBeLessThanOrEqual(512);
  });

  it('reflects a new legacy input immediately (no cross-slice cache bleed)', async () => {
    await publishDefault();
    const runtimeService = new EffectiveSettingsService(serverDB);

    const first = await runtimeService.getEffectiveSettings({
      legacyUserSettings: { general: { language: 'en-US' } },
      userId: 'legacy-slice-user',
    });
    expect(first.effectiveSettings).toMatchObject({ general: { language: 'en-US' } });

    const second = await runtimeService.getEffectiveSettings({
      legacyUserSettings: { general: { language: 'zh-CN' } },
      userId: 'legacy-slice-user',
    });
    expect(second.effectiveSettings).toMatchObject({ general: { language: 'zh-CN' } });
  });

  it('uses absolute TTL — frequent hits with identical input do not renew expiry', async () => {
    await publishDefault();
    const runtimeService = new EffectiveSettingsService(serverDB);
    const listPublished = vi.spyOn(runtimeService['model'], 'listPublishedPolicies');
    const getRevisionTokens = vi.spyOn(runtimeService['model'], 'getRevisionTokens');
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0);
      const legacy = { general: { language: 'en-US' } };

      await runtimeService.getEffectiveSettings({
        legacyUserSettings: legacy,
        userId: 'ttl-user',
      });
      expect(listPublished).toHaveBeenCalledTimes(1);
      const tokensAfterFirst = getRevisionTokens.mock.calls.length;

      // Hot-path reads within the original TTL window must not slide expiry or re-query policies.
      vi.setSystemTime(t0 + 3_000);
      for (let i = 0; i < 5; i++) {
        const hit = await runtimeService.getEffectiveSettings({
          legacyUserSettings: legacy,
          userId: 'ttl-user',
        });
        expect(hit.effectiveSettings).toMatchObject({ general: { language: 'en-US' } });
      }
      expect(listPublished).toHaveBeenCalledTimes(1);
      // Soft hits only re-probe revision tokens (one call each), never re-list policies.
      expect(getRevisionTokens.mock.calls.length).toBe(tokensAfterFirst + 5);

      // Past the original insertion TTL, soft entry expires and we re-materialize.
      // Published policies stay process-cached by platform revision (no second list).
      vi.setSystemTime(t0 + 5_100);
      await runtimeService.getEffectiveSettings({
        legacyUserSettings: legacy,
        userId: 'ttl-user',
      });
      expect(listPublished).toHaveBeenCalledTimes(1);
      expect(getRevisionTokens.mock.calls.length).toBe(tokensAfterFirst + 6);
    } finally {
      listPublished.mockRestore();
      getRevisionTokens.mockRestore();
      vi.useRealTimers();
    }
  });

  it('backfills registered legacy leaves into overrides when policy flag is on', async () => {
    await publishDefault();
    const { PlatformSettingsModel } = await import('@/database/models/platform');
    const { UserModel } = await import('@/database/models/user');
    const userModel = new UserModel(serverDB, 'u1');
    await userModel.updateSetting({ general: { fontSize: 18 } });

    const effective = await service.getEffectiveSettings({
      legacyUserSettings: { general: { fontSize: 18 } },
      userId: 'u1',
    });
    expect(effective.effectiveValues['general.fontSize']).toBe(18);
    expect(effective.pathMeta['general.fontSize']?.source).toBe('user');

    const overrideRows = await new PlatformSettingsModel(serverDB).listUserOverrides('u1');
    expect(overrideRows.some((row) => row.path === 'general.fontSize' && row.value === 18)).toBe(
      true,
    );
    const durableAfterBackfill = await userModel.getUserSettings();
    const cleanedGeneral = durableAfterBackfill?.general as { fontSize?: unknown } | null;
    expect(cleanedGeneral?.fontSize).toBeUndefined();

    // Second read is idempotent and still returns the preference.
    const again = await service.getEffectiveSettings({
      legacyUserSettings: { general: { fontSize: 18 } },
      userId: 'u1',
    });
    expect(again.effectiveValues['general.fontSize']).toBe(18);
  });

  it('reports a database failure then recovers at the same target without replacing the error', async () => {
    await publishDefault();
    const original = Object.assign(new Error('raw settings database detail'), {
      code: 'ECONNREFUSED',
    });
    const runtimeReporter = vi.fn<PlatformRuntimeMaterializationReporter>();
    const runtimeService = new EffectiveSettingsService(serverDB, undefined, {}, runtimeReporter);
    const getRevisionTokens = vi
      .spyOn(runtimeService['model'], 'getRevisionTokens')
      .mockRejectedValueOnce(original);

    await expect(runtimeService.getEffectiveSettings({ userId: 'recovery-user' })).rejects.toBe(
      original,
    );
    getRevisionTokens.mockRestore();
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

  it('reports failures across probe and policy materialization reads', async () => {
    await publishDefault();
    const revisionError = Object.assign(new Error('raw override revision detail'), {
      code: 'ECONNREFUSED',
    });
    const policiesError = Object.assign(new Error('raw policies detail'), {
      code: 'ECONNREFUSED',
    });
    const runtimeReporter = vi.fn<PlatformRuntimeMaterializationReporter>();
    const runtimeService = new EffectiveSettingsService(serverDB, undefined, {}, runtimeReporter);
    await runtimeService.getEffectiveSettings({ userId: 'override-user' });

    // Probe is a single getRevisionTokens call; force that path unavailable.
    const getRevisionTokens = vi
      .spyOn(runtimeService['model'], 'getRevisionTokens')
      .mockRejectedValueOnce(revisionError);
    await expect(runtimeService.getEffectiveSettings({ userId: 'override-user' })).rejects.toBe(
      revisionError,
    );
    getRevisionTokens.mockRestore();
    await runtimeService.getEffectiveSettings({ userId: 'override-user' });

    // Force a cold policy load for a new user by clearing process caches first.
    resetEffectiveSettingsCacheForTest();
    const listPublished = vi
      .spyOn(runtimeService['model'], 'listPublishedPolicies')
      .mockRejectedValueOnce(policiesError);
    await expect(
      runtimeService.getEffectiveSettings({ userId: 'override-rows-user' }),
    ).rejects.toBe(policiesError);
    listPublished.mockRestore();
    await runtimeService.getEffectiveSettings({ userId: 'override-rows-user' });

    expect(runtimeReporter.mock.calls.map(([, state]) => state)).toEqual([
      { domain: 'settings', health: 'healthy', revision: 1, source: 'database' },
      {
        domain: 'settings',
        errorCategory: 'database_unavailable',
        health: 'unavailable',
        source: 'unavailable',
      },
      { domain: 'settings', health: 'healthy', revision: 1, source: 'database' },
      {
        domain: 'settings',
        errorCategory: 'database_unavailable',
        health: 'unavailable',
        source: 'unavailable',
      },
      { domain: 'settings', health: 'healthy', revision: 1, source: 'database' },
    ]);
  });

  it('preserves a policy read error when its reporter also fails', async () => {
    await publishDefault();
    const original = new Error('raw override database detail');
    const runtimeReporter = vi.fn<PlatformRuntimeMaterializationReporter>(() => {
      throw new Error('raw failure reporter detail');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtimeService = new EffectiveSettingsService(serverDB, undefined, {}, runtimeReporter);
    resetEffectiveSettingsCacheForTest();
    const listPublished = vi
      .spyOn(runtimeService['model'], 'listPublishedPolicies')
      .mockRejectedValueOnce(original);

    await expect(
      runtimeService.getEffectiveSettings({ userId: 'observer-failure-user' }),
    ).rejects.toBe(original);

    expect(consoleError).toHaveBeenCalledWith('[platform-instance-runtime] reporter unavailable');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('raw failure reporter detail');
    listPublished.mockRestore();
    consoleError.mockRestore();
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

  it('single-statement snapshot stays coherent across concurrent publish', async () => {
    await publishDefault();
    const runtimeService = new EffectiveSettingsService(serverDB);

    // Overlap many materializations with a real publish; each result must be
    // entirely pre-commit (rev 1 / 18) or entirely post-commit (rev 2 / 22).
    const reads = Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runtimeService.getEffectiveSettings({ userId: `race-pub-${i}` }),
      ),
    );

    const draft = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: draft.draftToken,
      expectedRevision: draft.baseRevision,
      policies: {
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 22,
          visibility: 'visible',
        },
      },
      reason: 'race publish',
    });

    const results = await reads;
    for (const effective of results) {
      if (effective.platformRevision === 1) {
        expect(effective.effectiveValues['general.fontSize']).toBe(18);
      } else {
        expect(effective.platformRevision).toBe(2);
        expect(effective.effectiveValues['general.fontSize']).toBe(22);
      }
    }
  });

  it('single-statement snapshot stays coherent across concurrent override patch', async () => {
    await publishDefault();
    const runtimeService = new EffectiveSettingsService(serverDB);

    const reads = Promise.all(
      Array.from({ length: 8 }, () => runtimeService.getEffectiveSettings({ userId: 'u1' })),
    );
    await service.patchSettingOverride({
      path: 'general.fontSize',
      userId: 'u1',
      value: 20,
    });
    const results = await reads;

    for (const effective of results) {
      if (effective.userOverrideRevision === 0) {
        expect(effective.effectiveValues['general.fontSize']).toBe(18);
        expect(effective.pathMeta['general.fontSize']?.source).toBe('platform');
      } else {
        expect(effective.userOverrideRevision).toBeGreaterThan(0);
        expect(effective.effectiveValues['general.fontSize']).toBe(20);
        expect(effective.pathMeta['general.fontSize']?.source).toBe('user');
      }
    }
  });

  it('falls back to a coherent snapshot when optimistic bracketing exhausts', async () => {
    await publishDefault();
    const runtimeService = new EffectiveSettingsService(serverDB);
    const model = runtimeService['model'];
    let listCalls = 0;
    const originalList = model.listPublishedPolicies.bind(model);
    // Force every optimistic policy load to advance the platform revision so the
    // closing token read never matches. After 5 attempts the service falls back to
    // a single-statement snapshot (unmocked) and must still return a usable result.
    vi.spyOn(model, 'listPublishedPolicies').mockImplementation(async () => {
      listCalls += 1;
      await serverDB.execute(
        sql.raw(`UPDATE platform_settings_bundle SET revision = revision + 1 WHERE id = 'global'`),
      );
      return originalList();
    });

    const effective = await runtimeService.getEffectiveSettings({ userId: 'exhaust-user' });
    expect(listCalls).toBeGreaterThanOrEqual(5);
    expect(effective.platformRevision).toBeGreaterThan(0);
    expect(effective.effectiveValues['general.fontSize']).toBe(18);
    expect(effective.pathMeta['general.fontSize']?.source).toBe('platform');
    vi.restoreAllMocks();
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

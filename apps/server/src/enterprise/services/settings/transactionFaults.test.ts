// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformSettingsModel } from '@/database/models/platform';
import { UserModel } from '@/database/models/user';
import {
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
  platformSettingsBundle,
  userSettingOverrideRevisions,
  userSettingOverrides,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { AdminSettingsService } from './adminSettingsService';
import { EffectiveSettingsService } from './effectiveSettingsService';

vi.mock('../../featureFlags', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getDefaultEnterpriseFeatureFlags: () => Record<string, boolean>;
  };
  return {
    ...actual,
    getEnterpriseFeatureFlags: () => ({
      ...actual.getDefaultEnterpriseFeatureFlags(),
      ENABLE_PLATFORM_SETTINGS_POLICY: true,
    }),
  };
});

const serverDB: LobeChatDatabase = await getTestDB();

/** TRUNCATE bypasses append-only audit/revision immutability triggers (migration 0145). */
const clearState = async () => {
  await serverDB.execute(
    sql.raw(`
      TRUNCATE TABLE
        platform_audit_logs,
        platform_resource_revisions,
        user_setting_overrides,
        user_setting_override_revisions,
        platform_setting_policies,
        platform_settings_bundle,
        user_settings,
        users
      CASCADE
    `),
  );
};

beforeEach(async () => {
  await clearState();
  await serverDB.insert(users).values({ id: 'u-fault' });
});

afterEach(clearState);

const policy = (value: boolean) => ({
  'memory.enabled': {
    mode: 'default' as const,
    schemaVersion: 1,
    value,
    visibility: 'visible' as const,
  },
});

describe('M05 transaction fault injection', () => {
  it('rejects an unknown ReasoningGraph field before any persistence or invalidation', async () => {
    const user = new UserModel(serverDB, 'u-fault');
    await user.updateSetting({ hotkey: { search: 'keep' }, keyVaults: 'encrypted-keep' });
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new EffectiveSettingsService(serverDB, invalidation);

    await expect(
      service.applyLegacyUpdateSettings({
        input: {
          defaultAgent: {
            config: {
              chatConfig: {
                graph: {
                  edges: [
                    {
                      from: '__root__',
                      instruction: 'Run',
                      to: 'node-1',
                    },
                  ],
                  fields: {},
                  name: 'invalid graph',
                  nodes: { 'node-1': { type: 'llm', unknownNode: true } },
                  terminal: 'node-1',
                },
              },
            },
          },
        },
        userId: 'u-fault',
      }),
    ).rejects.toMatchObject({ code: 'MANAGED_SETTING_UNKNOWN_PATH' });

    const [settings, overrides, overrideRevisions, bundles, audits] = await Promise.all([
      user.getUserSettings(),
      serverDB.select().from(userSettingOverrides),
      serverDB.select().from(userSettingOverrideRevisions),
      serverDB.select().from(platformSettingsBundle),
      serverDB.select().from(platformAuditLogs),
    ]);
    expect(settings).toMatchObject({
      hotkey: { search: 'keep' },
      keyVaults: 'encrypted-keep',
    });
    expect(overrides).toEqual([]);
    expect(overrideRevisions).toEqual([]);
    expect(bundles).toEqual([]);
    expect(audits.filter((row) => row.result === 'success')).toEqual([]);
    expect(invalidation.events).toEqual([]);
  });

  it('rolls back revision, pointer, materialized policies and success audit on save fault', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const admin = new AdminSettingsService(serverDB, {
      invalidation,
      lifecycle: {
        afterMaterialization: async () => {
          throw new Error('save materialization fault');
        },
      },
    });
    const base = await admin.getDraft();

    await expect(
      admin.save({
        actorUserId: 'admin',
        expectedDraftToken: base.draftToken,
        expectedRevision: base.baseRevision,
        policies: policy(true),
        reason: 'save',
      }),
    ).rejects.toThrow('save materialization fault');

    const [bundles, revisions, policies, audits] = await Promise.all([
      serverDB.select().from(platformSettingsBundle),
      serverDB.select().from(platformResourceRevisions),
      serverDB.select().from(platformSettingPolicies),
      serverDB.select().from(platformAuditLogs),
    ]);
    expect(bundles[0]?.revision).toBe(0);
    expect(bundles[0]?.draft).toEqual({});
    expect(revisions).toEqual([]);
    expect(policies).toEqual([]);
    expect(audits.filter((row) => row.result === 'success')).toEqual([]);
    expect(audits.filter((row) => row.action === 'admin.settings.save')).toMatchObject([
      { afterDiff: { error: 'internal' }, result: 'failure' },
    ]);
    expect(invalidation.events).toEqual([]);
  });

  it('rolls back the entire applyImmediate write when materialization faults', async () => {
    const seed = new AdminSettingsService(serverDB, {
      invalidation: new InMemoryPlatformConfigInvalidationPublisher(),
    });
    await seed.applyImmediate({
      actorUserId: 'admin',
      patch: { 'memory.enabled': true },
      reason: 'seed published state',
    });
    const before = await seed.getDraft();
    expect(before.baseRevision).toBe(1);

    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const failing = new AdminSettingsService(serverDB, {
      invalidation,
      lifecycle: {
        afterMaterialization: async () => {
          throw new Error('apply materialization fault');
        },
      },
    });

    await expect(
      failing.applyImmediate({
        actorUserId: 'admin',
        patch: { 'general.fontSize': 20, 'memory.enabled': false },
        reason: 'apply',
      }),
    ).rejects.toThrow('apply materialization fault');

    // Draft alignment and materialization share ONE transaction now: a mid-way fault
    // leaves NOTHING behind — there is no half-written draft to restore afterwards.
    const model = new PlatformSettingsModel(serverDB);
    const [bundle, revisions, memoryPolicy, fontPolicy, audits] = await Promise.all([
      model.getBundle(),
      serverDB.select().from(platformResourceRevisions),
      model.getPublishedPolicy('memory.enabled'),
      model.getPublishedPolicy('general.fontSize'),
      serverDB.select().from(platformAuditLogs),
    ]);
    expect(bundle?.revision).toBe(1);
    expect(bundle?.draft).toEqual(before.draft);
    expect(revisions).toHaveLength(1);
    expect(memoryPolicy?.value).toBe(true);
    expect(fontPolicy).toBeUndefined();
    expect(
      audits.filter(
        (row) => row.action === 'admin.settings.applyImmediate' && row.result === 'failure',
      ),
    ).toMatchObject([{ afterDiff: { error: 'internal' } }]);
    expect(invalidation.events).toEqual([]);
  });

  it('rolls back override/revision/legacy/keyVault writes when a later legacy step fails', async () => {
    const user = new UserModel(serverDB, 'u-fault');
    await user.updateSetting({
      general: { fontSize: 13 },
      hotkey: { search: 'old' },
      keyVaults: 'encrypted-old',
    });
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new EffectiveSettingsService(serverDB, invalidation, {
      beforeLegacyWrite: async (operation) => {
        if (operation === 'legacyUpdate') throw new Error('legacy write fault');
      },
    });

    await expect(
      service.applyLegacyUpdateSettings({
        encryptedKeyVaults: 'encrypted-new',
        input: {
          general: { fontSize: 18 },
          hotkey: { search: 'new' },
          keyVaults: { openai: { apiKey: 'not-persisted-raw' } },
        },
        userId: 'u-fault',
      }),
    ).rejects.toThrow('legacy write fault');

    const [settings, overrides, revisions] = await Promise.all([
      user.getUserSettings(),
      serverDB.select().from(userSettingOverrides),
      serverDB.select().from(userSettingOverrideRevisions),
    ]);
    expect(settings).toMatchObject({
      general: { fontSize: 13 },
      hotkey: { search: 'old' },
      keyVaults: 'encrypted-old',
    });
    expect(overrides).toEqual([]);
    expect(revisions).toEqual([]);
    expect(invalidation.events).toEqual([]);
  });

  it('rolls back legacy backfill overrides and revision when durable cleanup fails', async () => {
    const user = new UserModel(serverDB, 'u-fault');
    await user.updateSetting({
      general: { fontSize: 17 },
      hotkey: { search: 'keep' },
      keyVaults: 'encrypted-keep',
    });
    await expect(
      new EffectiveSettingsService(serverDB, undefined, {
        beforeLegacyBackfillCleanup: async () => {
          throw new Error('backfill cleanup fault');
        },
      }).getEffectiveSettings({
        legacyUserSettings: { general: { fontSize: 17 } },
        userId: 'u-fault',
      }),
    ).rejects.toThrow('backfill cleanup fault');

    const [settings, overrides, revisions] = await Promise.all([
      user.getUserSettings(),
      serverDB.select().from(userSettingOverrides),
      serverDB.select().from(userSettingOverrideRevisions),
    ]);
    expect(settings).toMatchObject({
      general: { fontSize: 17 },
      hotkey: { search: 'keep' },
      keyVaults: 'encrypted-keep',
    });
    expect(overrides).toEqual([]);
    expect(revisions).toEqual([]);
  });

  it('rolls back both managed overrides when faulted after the second override write', async () => {
    const user = new UserModel(serverDB, 'u-fault');
    await user.updateSetting({ hotkey: { search: 'old' }, keyVaults: 'encrypted-old' });
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new EffectiveSettingsService(serverDB, invalidation, {
      afterManagedOverrideWrite: async (operation, index) => {
        if (operation === 'legacyUpdate' && index === 1) throw new Error('second override fault');
      },
    });

    await expect(
      service.applyLegacyUpdateSettings({
        input: {
          general: { fontSize: 18 },
          hotkey: { search: 'new' },
          memory: { enabled: true },
        },
        userId: 'u-fault',
      }),
    ).rejects.toThrow('second override fault');

    const [settings, overrides, revisions, successAudits] = await Promise.all([
      user.getUserSettings(),
      serverDB.select().from(userSettingOverrides),
      serverDB.select().from(userSettingOverrideRevisions),
      serverDB.select().from(platformAuditLogs),
    ]);
    expect(settings).toMatchObject({
      hotkey: { search: 'old' },
      keyVaults: 'encrypted-old',
    });
    expect(overrides).toEqual([]);
    expect(revisions).toEqual([]);
    expect(successAudits.filter((row) => row.result === 'success')).toEqual([]);
    expect(invalidation.events).toEqual([]);
  });

  it('rolls back both managed overrides when faulted immediately before revision bump', async () => {
    const user = new UserModel(serverDB, 'u-fault');
    await user.updateSetting({ hotkey: { search: 'old' }, keyVaults: 'encrypted-old' });
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new EffectiveSettingsService(serverDB, invalidation, {
      beforeOverrideRevisionBump: async () => {
        throw new Error('revision bump fault');
      },
    });

    await expect(
      service.applyLegacyUpdateSettings({
        input: {
          general: { fontSize: 18 },
          hotkey: { search: 'new' },
          memory: { enabled: true },
        },
        userId: 'u-fault',
      }),
    ).rejects.toThrow('revision bump fault');

    const [settings, overrides, revisions] = await Promise.all([
      user.getUserSettings(),
      serverDB.select().from(userSettingOverrides),
      serverDB.select().from(userSettingOverrideRevisions),
    ]);
    expect(settings).toMatchObject({
      hotkey: { search: 'old' },
      keyVaults: 'encrypted-old',
    });
    expect(overrides).toEqual([]);
    expect(revisions).toEqual([]);
    expect(invalidation.events).toEqual([]);
  });

  it('single reset deletes only its target and preserves legacy, encrypted keyVault and other override', async () => {
    const user = new UserModel(serverDB, 'u-fault');
    await user.updateSetting({
      general: { fontSize: 13 },
      hotkey: { search: 'keep' },
      keyVaults: 'encrypted-keep',
    });
    const model = new PlatformSettingsModel(serverDB);
    await model.upsertUserOverride({ path: 'general.fontSize', userId: 'u-fault', value: 17 });
    await model.upsertUserOverride({ path: 'memory.enabled', userId: 'u-fault', value: true });
    const revisionBefore = await model.getUserOverrideRevision('u-fault');
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new EffectiveSettingsService(serverDB, invalidation);

    const result = await service.resetSettingOverride({
      client: 'web',
      path: 'general.fontSize',
      userId: 'u-fault',
    });

    const [settings, target, unrelated, revisionAfter] = await Promise.all([
      user.getUserSettings(),
      model.getUserOverride('u-fault', 'general.fontSize'),
      model.getUserOverride('u-fault', 'memory.enabled'),
      model.getUserOverrideRevision('u-fault'),
    ]);
    expect(result.deleted).toBe(true);
    expect(target).toBeUndefined();
    expect(unrelated?.value).toBe(true);
    // F1: registered leaves are stripped from durable legacy on reset so the next
    // getEffective backfill cannot re-materialize the same preference. When
    // general only held fontSize, the top-level column is null (not a partial
    // shell). Unregistered blobs (hotkey) and secrets (keyVaults) are preserved.
    expect(settings).toMatchObject({
      general: null,
      hotkey: { search: 'keep' },
      keyVaults: 'encrypted-keep',
    });
    expect(revisionAfter).toBe(revisionBefore + 1);
    expect(invalidation.events).toHaveLength(1);
  });

  it('rolls back full reset override deletion, revision bump and legacy/keyVault deletion', async () => {
    const user = new UserModel(serverDB, 'u-fault');
    await user.updateSetting({ general: { fontSize: 16 }, keyVaults: 'encrypted-old' });
    const seed = new EffectiveSettingsService(
      serverDB,
      new InMemoryPlatformConfigInvalidationPublisher(),
    );
    await seed.patchSettingOverride({
      client: 'web',
      path: 'general.fontSize',
      userId: 'u-fault',
      value: 17,
    });
    const revisionBefore = await new PlatformSettingsModel(serverDB).getUserOverrideRevision(
      'u-fault',
    );

    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const failing = new EffectiveSettingsService(serverDB, invalidation, {
      beforeLegacyWrite: async (operation) => {
        if (operation === 'fullReset') throw new Error('full reset legacy fault');
      },
    });
    await expect(failing.fullResetSettings({ userId: 'u-fault' })).rejects.toThrow(
      'full reset legacy fault',
    );

    const model = new PlatformSettingsModel(serverDB);
    const [settings, override, revisionAfter] = await Promise.all([
      user.getUserSettings(),
      model.getUserOverride('u-fault', 'general.fontSize'),
      model.getUserOverrideRevision('u-fault'),
    ]);
    expect(settings).toMatchObject({
      general: { fontSize: 16 },
      keyVaults: 'encrypted-old',
    });
    expect(override?.value).toBe(17);
    expect(revisionAfter).toBe(revisionBefore);
    expect(invalidation.events).toEqual([]);
  });
});

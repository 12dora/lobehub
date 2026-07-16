// @vitest-environment node
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
import { users, userSettings } from '@/database/schemas/user';
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

const clearState = async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(userSettings);
  await serverDB.delete(users);
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
  it('rolls back revision, pointer, materialized policies and success audit on publish fault', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const admin = new AdminSettingsService(serverDB, {
      invalidation,
      lifecycle: {
        afterMaterialization: async () => {
          throw new Error('publish materialization fault');
        },
      },
    });
    await admin.saveDraft({ actorUserId: 'admin', draft: policy(true), reason: 'draft' });

    await expect(
      admin.publish({ actorUserId: 'admin', expectedRevision: 0, reason: 'publish' }),
    ).rejects.toThrow('publish materialization fault');

    const [bundles, revisions, policies, audits] = await Promise.all([
      serverDB.select().from(platformSettingsBundle),
      serverDB.select().from(platformResourceRevisions),
      serverDB.select().from(platformSettingPolicies),
      serverDB.select().from(platformAuditLogs),
    ]);
    expect(bundles[0]?.revision).toBe(0);
    expect(revisions).toEqual([]);
    expect(policies).toEqual([]);
    expect(audits.filter((row) => row.result === 'success')).toHaveLength(1);
    expect(audits.filter((row) => row.action === 'admin.settings.publish')).toMatchObject([
      { result: 'failure' },
    ]);
    expect(invalidation.events).toEqual([]);
  });

  it('rolls back a failed rollback head, pointer, draft and materialized policies', async () => {
    const seedInvalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const seed = new AdminSettingsService(serverDB, { invalidation: seedInvalidation });
    await seed.saveDraft({ actorUserId: 'admin', draft: policy(true), reason: 'draft-1' });
    await seed.publish({ actorUserId: 'admin', expectedRevision: 0, reason: 'publish-1' });
    await seed.saveDraft({ actorUserId: 'admin', draft: policy(false), reason: 'draft-2' });
    await seed.publish({ actorUserId: 'admin', expectedRevision: 1, reason: 'publish-2' });

    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const failing = new AdminSettingsService(serverDB, {
      invalidation,
      lifecycle: {
        afterMaterialization: async (operation) => {
          if (operation === 'rollback') throw new Error('rollback materialization fault');
        },
      },
    });
    await expect(
      failing.rollback({
        actorUserId: 'admin',
        expectedRevision: 2,
        reason: 'rollback',
        targetRevision: 1,
      }),
    ).rejects.toThrow('rollback materialization fault');

    const model = new PlatformSettingsModel(serverDB);
    const [bundle, revisions, published, audits] = await Promise.all([
      model.getBundle(),
      serverDB.select().from(platformResourceRevisions),
      model.getPublishedPolicy('memory.enabled'),
      serverDB.select().from(platformAuditLogs),
    ]);
    expect(bundle?.revision).toBe(2);
    expect(bundle?.draft).toEqual(policy(false));
    expect(revisions).toHaveLength(2);
    expect(published?.value).toBe(false);
    expect(audits.filter((row) => row.action === 'platform.settings.rollback')).toEqual([]);
    expect(audits.filter((row) => row.action === 'admin.settings.rollback')).toMatchObject([
      { result: 'failure' },
    ]);
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

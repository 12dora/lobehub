// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import { users } from '@/database/schemas';
import {
  platformAiProviders,
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { PlatformDependencyTargetNotPublishedError } from '../platformDependencyLock';
import {
  AdminSettingsService,
  PlatformRevisionConflictError,
  SettingsDraftValidationError,
} from './adminSettingsService';
import { settingsRegistry } from './registry';

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

const serverDB: LobeChatDatabase = await getTestDB();
const service = new AdminSettingsService(serverDB);

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
        platform_settings_bundle,
        platform_ai_providers
      CASCADE
    `),
  );
};

beforeEach(async () => {
  await resetSettingsTables();
  await serverDB
    .insert(users)
    .values([{ id: 'u1' }, { id: 'u2' }])
    .onConflictDoNothing();
});

afterEach(async () => {
  await resetSettingsTables();
});

const validDraft = {
  'general.fontSize': {
    mode: 'default' as const,
    schemaVersion: 1,
    value: 18,
    visibility: 'visible' as const,
  },
  'memory.enabled': {
    mode: 'locked' as const,
    schemaVersion: 1,
    value: true,
    visibility: 'visible' as const,
  },
};

/** De-drafted write against the current CAS base (the only settings write path). */
const saveCurrent = async (
  target: AdminSettingsService,
  params: Omit<
    Parameters<AdminSettingsService['save']>[0],
    'expectedDraftToken' | 'expectedRevision'
  >,
) => {
  const base = await target.getDraft();
  return target.save({
    ...params,
    expectedDraftToken: base.draftToken,
    expectedRevision: base.baseRevision,
  });
};

describe('AdminSettingsService', () => {
  it('getDraft returns registry + empty draft for new bundle', async () => {
    const draft = await service.getDraft();
    expect(draft.baseRevision).toBe(0);
    expect(draft.registryVersion).toBe(settingsRegistry.version);
    expect(draft.registry.length).toBeGreaterThan(10);
    expect(draft.draft).toEqual({});
    expect(draft.draftToken).toMatch(/^[\da-f]{64}$/);
  });

  it('save validates the whole payload before write; rejects unknown path', async () => {
    await expect(
      saveCurrent(service, {
        actorUserId: 'admin-1',
        policies: {
          'not.registered': {
            mode: 'default',
            schemaVersion: 1,
            value: 1,
            visibility: 'visible',
          },
        },
        reason: 'bad path',
      }),
    ).rejects.toBeInstanceOf(SettingsDraftValidationError);

    // nothing persisted
    const draft = await service.getDraft();
    expect(draft.draft).toEqual({});
    const audits = await serverDB.select().from(platformAuditLogs);
    expect(audits).toMatchObject([
      {
        action: 'admin.settings.save',
        afterDiff: { error: 'validation' },
        result: 'failure',
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('not.registered');
  });

  it('rejects applying AI references whose target is not currently published', async () => {
    await expect(
      service.applyImmediate({
        actorUserId: 'admin-1',
        patch: {
          'systemAgent.topic.model': 'missing-model',
          'systemAgent.topic.provider': 'missing-provider',
        },
        reason: 'must fail closed',
      }),
    ).rejects.toBeInstanceOf(PlatformDependencyTargetNotPublishedError);
    expect(await serverDB.select().from(platformSettingPolicies)).toEqual([]);
  });

  it('rejects an orphan higher AI revision when the current pointer lacks the model', async () => {
    const currentPayload = {
      models: [{ enabled: true, modelKey: 'current-only', type: 'chat' }],
      provider: {
        displayName: 'Alpha',
        enabled: true,
        providerKey: 'alpha',
      },
    };
    const orphanPayload = {
      models: [{ enabled: true, modelKey: 'orphan-only', type: 'chat' }],
      provider: {
        displayName: 'Alpha',
        enabled: true,
        providerKey: 'alpha',
      },
    };
    await serverDB.insert(platformAiProviders).values({
      displayName: 'Alpha',
      enabled: true,
      id: 'provider-alpha',
      providerKey: 'alpha',
      revision: 1,
      status: 'published',
    });
    await serverDB.insert(platformResourceRevisions).values([
      {
        checksum: checksumPayload(currentPayload),
        payload: currentPayload,
        resourceId: 'provider-alpha',
        resourceType: 'provider',
        revision: 1,
        status: 'published',
      },
      {
        checksum: checksumPayload(orphanPayload),
        payload: orphanPayload,
        resourceId: 'provider-alpha',
        resourceType: 'provider',
        revision: 2,
        status: 'published',
      },
    ]);
    await expect(
      service.applyImmediate({
        actorUserId: 'admin-1',
        patch: {
          'systemAgent.topic.model': 'orphan-only',
          'systemAgent.topic.provider': 'alpha',
        },
        reason: 'must use current pointer',
      }),
    ).rejects.toBeInstanceOf(PlatformDependencyTargetNotPublishedError);
    expect(await serverDB.select().from(platformSettingPolicies)).toEqual([]);
  });

  it('accepts the rolled-back AI pointer even when higher history lacks the model', async () => {
    const rollbackPayload = {
      models: [{ enabled: true, modelKey: 'rollback-model', type: 'chat' }],
      provider: {
        displayName: 'Alpha',
        enabled: true,
        providerKey: 'alpha',
      },
    };
    const higherPayload = {
      models: [{ enabled: true, modelKey: 'higher-only', type: 'chat' }],
      provider: {
        displayName: 'Alpha',
        enabled: true,
        providerKey: 'alpha',
      },
    };
    await serverDB.insert(platformAiProviders).values({
      displayName: 'Alpha',
      enabled: true,
      id: 'provider-alpha',
      providerKey: 'alpha',
      revision: 2,
      status: 'published',
    });
    await serverDB.insert(platformResourceRevisions).values([
      {
        checksum: checksumPayload(rollbackPayload),
        payload: rollbackPayload,
        resourceId: 'provider-alpha',
        resourceType: 'provider',
        revision: 1,
        status: 'published',
      },
      {
        checksum: checksumPayload(higherPayload),
        payload: higherPayload,
        resourceId: 'provider-alpha',
        resourceType: 'provider',
        revision: 2,
        status: 'published',
      },
    ]);
    await serverDB
      .update(platformAiProviders)
      .set({ revision: 1 })
      .where(eq(platformAiProviders.id, 'provider-alpha'));
    await expect(
      service.applyImmediate({
        actorUserId: 'admin-1',
        patch: {
          'systemAgent.topic.model': 'rollback-model',
          'systemAgent.topic.provider': 'alpha',
        },
        reason: 'apply against rollback pointer',
      }),
    ).resolves.toMatchObject({ revision: 1 });
    expect(await serverDB.select().from(platformSettingPolicies)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'systemAgent.topic.model', value: 'rollback-model' }),
      ]),
    );
  });

  it('appends one revision per save and keeps history append-only', async () => {
    const v1 = await saveCurrent(service, {
      actorUserId: 'admin-1',
      policies: validDraft,
      reason: 'set defaults',
    });
    expect(v1.revision).toBe(1);

    // a replayed CAS base is stale and cannot append a second revision
    await expect(
      service.save({
        actorUserId: 'admin-1',
        expectedDraftToken: (await service.getDraft()).draftToken,
        expectedRevision: 0,
        policies: validDraft,
        reason: 'stale',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const v2 = await saveCurrent(service, {
      actorUserId: 'admin-1',
      policies: {
        ...validDraft,
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 20,
          visibility: 'visible',
        },
      },
      reason: 'bump font',
    });
    expect(v2.revision).toBe(2);

    const after = await service.getDraft();
    expect(after.baseRevision).toBe(2);
    expect(after.publishedPolicies['general.fontSize']?.value).toBe(20);
    expect(after.draft).toEqual(after.publishedPolicies);
    expect(
      (await serverDB.select().from(platformResourceRevisions)).map((row) => row.revision).sort(),
    ).toEqual([1, 2]);
  });

  it('validateDraft estimates override impact without scanning users', async () => {
    // seed overrides via model tables
    const { PlatformSettingsModel } = await import('@/database/models/platform');
    const model = new PlatformSettingsModel(serverDB);
    await model.upsertUserOverride({ path: 'general.fontSize', userId: 'u1', value: 16 });
    await model.upsertUserOverride({ path: 'general.fontSize', userId: 'u2', value: 14 });

    const result = await service.validateDraft(validDraft);
    expect(result.ok).toBe(true);
    expect(result.impactEstimate.totalOverrideRows).toBeGreaterThanOrEqual(2);
  });

  it('rejects secret path and wrong type', async () => {
    const secret = await service.validateDraft({
      'keyVaults.openai': {
        mode: 'default',
        schemaVersion: 1,
        value: { apiKey: 'x' },
        visibility: 'visible',
      },
    });
    expect(secret.ok).toBe(false);
    expect(secret.issues[0]?.code).toMatch(/SECRET|UNKNOWN/);

    const badType = await service.validateDraft({
      'general.fontSize': {
        mode: 'default',
        schemaVersion: 1,
        value: 'not-a-number',
        visibility: 'visible',
      },
    });
    expect(badType.ok).toBe(false);
    expect(badType.issues[0]?.code).toBe('MANAGED_SETTING_INVALID_VALUE');
  });

  it('classifies write availability failures with a dedicated afterDiff.error category', async () => {
    const failing = new AdminSettingsService(serverDB, {
      lifecycle: {
        afterMaterialization: async () => {
          throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
        },
      },
    });

    await expect(
      saveCurrent(failing, {
        actorUserId: 'admin-1',
        policies: validDraft,
        reason: 'save while DB unavailable',
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    const audits = await serverDB.select().from(platformAuditLogs);
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.settings.save',
        afterDiff: { error: 'availability' },
        result: 'failure',
      }),
    );
    expect(JSON.stringify(audits)).not.toContain('connection refused');
  });

  it('audit append failure rolls back the settings write and never emits false success', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auditAppend = vi.fn().mockRejectedValue(new Error('audit unavailable'));

    await expect(
      saveCurrent(new AdminSettingsService(serverDB, { auditAppend }), {
        actorUserId: 'admin-1',
        policies: validDraft,
        reason: 'must be audited',
      }),
    ).rejects.toThrow('audit unavailable');
    consoleSpy.mockRestore();

    const [bundle, audits, policies] = await Promise.all([
      new AdminSettingsService(serverDB).getDraft(),
      serverDB.select().from(platformAuditLogs),
      serverDB.select().from(platformSettingPolicies),
    ]);
    expect(bundle.draft).toEqual({});
    expect(bundle.baseRevision).toBe(0);
    expect(policies).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('AdminSettingsService.save', () => {
  it('publishes the payload site-wide in one transaction and aligns the draft column', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const admin = new AdminSettingsService(serverDB, { invalidation });
    const base = await admin.getDraft();

    const result = await admin.save({
      actorUserId: 'u1',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: validDraft,
      reason: 'apply settings policy',
    });

    expect(result).toMatchObject({ auditId: expect.any(String), revision: 1 });
    const after = await admin.getDraft();
    expect(after.baseRevision).toBe(1);
    expect(after.publishedPolicies).toEqual(validDraft);
    expect(after.draft).toEqual(validDraft);
    expect(after.draftToken).toBe(result.draftToken);
    expect(await serverDB.select().from(platformResourceRevisions)).toHaveLength(1);
    expect(invalidation.events).toHaveLength(1);
    expect(invalidation.events[0]?.scopes).toEqual(['settings']);
    const audits = await serverDB.select().from(platformAuditLogs);
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.settings.save',
        actorUserId: 'u1',
        configRevision: 1,
        result: 'success',
      }),
    );
    expect(audits.find((row) => row.action === 'admin.settings.save')?.id).toBe(result.auditId);
  });

  it('rejects an invalid payload with a failure audit and no state change', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const admin = new AdminSettingsService(serverDB, { invalidation });
    const base = await admin.getDraft();

    await expect(
      admin.save({
        actorUserId: 'u1',
        expectedDraftToken: base.draftToken,
        expectedRevision: base.baseRevision,
        policies: {
          'general.fontSize': {
            mode: 'default',
            schemaVersion: 1,
            value: 9999,
            visibility: 'visible',
          },
        },
        reason: 'out-of-range value',
      }),
    ).rejects.toBeInstanceOf(SettingsDraftValidationError);

    expect(await serverDB.select().from(platformResourceRevisions)).toEqual([]);
    expect(await serverDB.select().from(platformSettingPolicies)).toEqual([]);
    expect(invalidation.events).toEqual([]);
    expect((await admin.getDraft()).draftToken).toBe(base.draftToken);
    expect(await serverDB.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.settings.save',
        afterDiff: { error: 'validation' },
        result: 'failure',
      }),
    );
  });

  it('rejects a stale CAS base without touching published state', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const admin = new AdminSettingsService(serverDB, { invalidation });
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'u1',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: validDraft,
      reason: 'first writer',
    });

    await expect(
      admin.save({
        actorUserId: 'u2',
        expectedDraftToken: base.draftToken,
        expectedRevision: base.baseRevision,
        policies: {},
        reason: 'stale base',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const after = await admin.getDraft();
    expect(after.baseRevision).toBe(1);
    expect(after.publishedPolicies).toEqual(validDraft);
    expect(invalidation.events).toHaveLength(1);
    const failure = (await serverDB.select().from(platformAuditLogs)).find(
      (row) => row.action === 'admin.settings.save' && row.result === 'failure',
    );
    expect(failure?.afterDiff).toEqual({ error: 'revision_conflict' });
    expect(JSON.stringify(failure)).not.toContain(base.draftToken);
  });
});

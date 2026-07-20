// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  platformAiProviders,
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
  platformSettingsBundle,
  userSettingOverrideRevisions,
  userSettingOverrides,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformDependencyTargetNotPublishedError } from '../platformDependencyLock';
import {
  AdminSettingsService,
  PlatformRevisionConflictError,
  SettingsDraftValidationError,
} from './adminSettingsService';
import { settingsRegistry } from './registry';

const serverDB: LobeChatDatabase = await getTestDB();
const service = new AdminSettingsService(serverDB);

beforeEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(platformAiProviders);
});

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(platformAiProviders);
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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const saveCurrentDraft = async (
  target: AdminSettingsService,
  params: Omit<Parameters<AdminSettingsService['saveDraft']>[0], 'expectedDraftToken'>,
) =>
  target.saveDraft({
    ...params,
    expectedDraftToken: (await target.getDraft()).draftToken,
  });

describe('AdminSettingsService', () => {
  it('getDraft returns registry + empty draft for new bundle', async () => {
    const draft = await service.getDraft();
    expect(draft.baseRevision).toBe(0);
    expect(draft.registryVersion).toBe(settingsRegistry.version);
    expect(draft.registry.length).toBeGreaterThan(10);
    expect(draft.draft).toEqual({});
    expect(draft.draftToken).toMatch(/^[\da-f]{64}$/);
  });

  it('saveDraft validates whole bundle before write; rejects unknown path', async () => {
    await expect(
      saveCurrentDraft(service, {
        actorUserId: 'admin-1',
        draft: {
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
        action: 'admin.settings.saveDraft',
        afterDiff: { issueCount: 1 },
        result: 'failure',
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('not.registered');
  });

  it('rejects publishing AI references whose target is not currently published', async () => {
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'systemAgent.topic.model': {
          mode: 'default',
          schemaVersion: 1,
          value: 'missing-model',
          visibility: 'visible',
        },
        'systemAgent.topic.provider': {
          mode: 'default',
          schemaVersion: 1,
          value: 'missing-provider',
          visibility: 'visible',
        },
      },
      reason: 'reference missing target',
    });

    await expect(
      service.publish({
        actorUserId: 'admin-1',
        expectedDraftToken: (await service.getDraft()).draftToken,
        expectedRevision: 0,
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
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'systemAgent.topic.model': {
          mode: 'default',
          schemaVersion: 1,
          value: 'orphan-only',
          visibility: 'visible',
        },
        'systemAgent.topic.provider': {
          mode: 'default',
          schemaVersion: 1,
          value: 'alpha',
          visibility: 'visible',
        },
      },
      reason: 'orphan history must not authorize settings',
    });

    await expect(
      service.publish({
        actorUserId: 'admin-1',
        expectedDraftToken: (await service.getDraft()).draftToken,
        expectedRevision: 0,
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
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'systemAgent.topic.model': {
          mode: 'default',
          schemaVersion: 1,
          value: 'rollback-model',
          visibility: 'visible',
        },
        'systemAgent.topic.provider': {
          mode: 'default',
          schemaVersion: 1,
          value: 'alpha',
          visibility: 'visible',
        },
      },
      reason: 'rolled back model is current',
    });

    await expect(
      service.publish({
        actorUserId: 'admin-1',
        expectedDraftToken: (await service.getDraft()).draftToken,
        expectedRevision: 0,
        reason: 'publish against rollback pointer',
      }),
    ).resolves.toMatchObject({ revision: 1 });
    expect(await serverDB.select().from(platformSettingPolicies)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'systemAgent.topic.model', value: 'rollback-model' }),
      ]),
    );
  });

  it('saveDraft + publish + rollback append-only flow', async () => {
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: validDraft,
      reason: 'set defaults',
    });

    const published = await service.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.getDraft()).draftToken,
      expectedRevision: 0,
      reason: 'publish v1',
    });
    expect(published.revision).toBe(1);

    // concurrent stale publish fails
    await expect(
      service.publish({
        actorUserId: 'admin-1',
        expectedDraftToken: (await service.getDraft()).draftToken,
        expectedRevision: 0,
        reason: 'stale',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    const conflictAudits = await serverDB.select().from(platformAuditLogs);
    expect(conflictAudits).toContainEqual(
      expect.objectContaining({ action: 'admin.settings.publish', result: 'failure' }),
    );

    // change draft and publish v2
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
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
    const v2 = await service.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.getDraft()).draftToken,
      expectedRevision: 1,
      reason: 'publish v2',
    });
    expect(v2.revision).toBe(2);

    const rolled = await service.rollback({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.getDraft()).draftToken,
      expectedRevision: 2,
      reason: 'restore v1',
      targetRevision: 1,
    });
    expect(rolled.revision).toBe(3);

    const after = await service.getDraft();
    expect(after.baseRevision).toBe(3);
    expect(after.publishedPolicies['general.fontSize']?.value).toBe(18);
    expect(after.draft['general.fontSize']?.value).toBe(18);
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

  it('audit append failure rolls back the settings write and never emits false success', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auditAppend = vi.fn().mockRejectedValue(new Error('audit unavailable'));

    await expect(
      saveCurrentDraft(new AdminSettingsService(serverDB, { auditAppend }), {
        actorUserId: 'admin-1',
        draft: validDraft,
        reason: 'must be audited',
      }),
    ).rejects.toThrow('audit unavailable');
    consoleSpy.mockRestore();

    const [bundle, audits] = await Promise.all([
      new AdminSettingsService(serverDB).getDraft(),
      serverDB.select().from(platformAuditLogs),
    ]);
    expect(bundle.draft).toEqual({});
    expect(audits).toEqual([]);
  });

  it('uses a locked draft CAS so two admins with one token cannot silently overwrite', async () => {
    const firstLocked = deferred();
    const releaseFirst = deferred();
    const first = new AdminSettingsService(serverDB, {
      lifecycle: {
        afterDraftLock: async () => {
          firstLocked.resolve();
          await releaseFirst.promise;
        },
      },
    });
    const second = new AdminSettingsService(serverDB);
    const sharedToken = (await first.getDraft()).draftToken;
    const firstDraft = validDraft;
    const secondDraft = {
      ...validDraft,
      'general.fontSize': { ...validDraft['general.fontSize'], value: 22 },
    };

    const firstSave = first.saveDraft({
      actorUserId: 'admin-1',
      draft: firstDraft,
      expectedDraftToken: sharedToken,
      reason: 'first writer',
    });
    await firstLocked.promise;
    const secondSave = second.saveDraft({
      actorUserId: 'admin-2',
      draft: secondDraft,
      expectedDraftToken: sharedToken,
      reason: 'second writer',
    });

    releaseFirst.resolve();
    const firstResult = await firstSave;
    await expect(secondSave).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    const [current, audits] = await Promise.all([
      second.getDraft(),
      serverDB.select().from(platformAuditLogs),
    ]);
    expect(current.draft).toEqual(firstDraft);
    expect(current.draftToken).toBe(firstResult.draftToken);
    expect(current.draftToken).not.toBe(sharedToken);
    expect(audits.filter((row) => row.action === 'admin.settings.saveDraft')).toMatchObject([
      { actorUserId: 'admin-1', result: 'success' },
      { actorUserId: 'admin-2', result: 'failure' },
    ]);
  });
});

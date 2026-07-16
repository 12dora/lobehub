// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
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

describe('AdminSettingsService', () => {
  it('getDraft returns registry + empty draft for new bundle', async () => {
    const draft = await service.getDraft();
    expect(draft.baseRevision).toBe(0);
    expect(draft.registryVersion).toBe(settingsRegistry.version);
    expect(draft.registry.length).toBeGreaterThan(10);
    expect(draft.draft).toEqual({});
  });

  it('saveDraft validates whole bundle before write; rejects unknown path', async () => {
    await expect(
      service.saveDraft({
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
  });

  it('saveDraft + publish + rollback append-only flow', async () => {
    await service.saveDraft({
      actorUserId: 'admin-1',
      draft: validDraft,
      reason: 'set defaults',
    });

    const published = await service.publish({
      actorUserId: 'admin-1',
      expectedRevision: 0,
      reason: 'publish v1',
    });
    expect(published.revision).toBe(1);

    // concurrent stale publish fails
    await expect(
      service.publish({
        actorUserId: 'admin-1',
        expectedRevision: 0,
        reason: 'stale',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    // change draft and publish v2
    await service.saveDraft({
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
      expectedRevision: 1,
      reason: 'publish v2',
    });
    expect(v2.revision).toBe(2);

    const rolled = await service.rollback({
      actorUserId: 'admin-1',
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
});

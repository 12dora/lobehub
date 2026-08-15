// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import { platformSettingPolicies } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { AdminSettingsService } from './adminSettingsService';

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

const saveCurrentDraft = async (
  target: AdminSettingsService,
  params: Omit<Parameters<AdminSettingsService['saveDraft']>[0], 'expectedDraftToken'>,
) =>
  target.saveDraft({
    ...params,
    expectedDraftToken: (await target.getDraft()).draftToken,
  });

describe('AdminSettingsService policy-editor ownership', () => {
  // image.* is service-model owned and does not require AI-catalog references to publish.
  const foreignPath = 'image.defaultImageNum';
  const foreignDefault = {
    mode: 'default' as const,
    schemaVersion: 1,
    value: 4,
    visibility: 'visible' as const,
  };
  const foreignUpdated = {
    mode: 'locked' as const,
    schemaVersion: 1,
    value: 12,
    visibility: 'hidden' as const,
  };

  const seedForeignViaFullOwnership = async () => {
    await saveCurrentDraft(service, {
      actorUserId: 'admin-sm',
      draft: {
        [foreignPath]: foreignDefault,
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 16,
          visibility: 'visible',
        },
      },
      ownership: 'full',
      reason: 'seed service-model + policy paths',
    });
    await service.publish({
      actorUserId: 'admin-sm',
      expectedDraftToken: (await service.getDraft()).draftToken,
      expectedRevision: 0,
      ownership: 'full',
      reason: 'publish seeded',
    });
  };

  it('empty policy-editor publish preserves foreign service-model rows', async () => {
    await seedForeignViaFullOwnership();

    await saveCurrentDraft(service, {
      actorUserId: 'admin-policy',
      draft: {},
      ownership: 'policy-editor',
      reason: 'clear owned overrides only',
    });

    const afterSave = await service.getDraft();
    expect(afterSave.draft[foreignPath]).toEqual(foreignDefault);
    expect(afterSave.draft['general.fontSize']).toBeUndefined();

    await service.publish({
      actorUserId: 'admin-policy',
      expectedDraftToken: afterSave.draftToken,
      expectedRevision: afterSave.baseRevision,
      ownership: 'policy-editor',
      reason: 'publish empty owned draft',
    });

    const published = await serverDB.select().from(platformSettingPolicies);
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: foreignPath,
          value: 4,
          mode: 'default',
          visibility: 'visible',
        }),
      ]),
    );
    expect(published.find((row) => row.path === 'general.fontSize')).toBeUndefined();
  });

  // R1: the 空草稿 regression (926e53e8d7). An empty policy-editor payload is 恢复默认 for
  // OWNED paths only — it must never become a whole-table replacement.
  it('save with an empty policy map preserves foreign published rows', async () => {
    await seedForeignViaFullOwnership();
    const before = await service.getDraft();
    expect(before.publishedPolicies[foreignPath]).toEqual(foreignDefault);
    expect(before.publishedPolicies['general.fontSize']?.value).toBe(16);

    const result = await service.save({
      actorUserId: 'admin-policy',
      expectedDraftToken: before.draftToken,
      expectedRevision: before.baseRevision,
      policies: {},
      reason: 'restore defaults for owned paths only',
    });
    expect(result.revision).toBe(2);
    expect(result.warnings).toBeUndefined();

    const published = await serverDB.select().from(platformSettingPolicies);
    expect(published.map((row) => row.path)).toEqual([foreignPath]);
    expect(published[0]).toMatchObject({ mode: 'default', value: 4, visibility: 'visible' });

    // Draft column is aligned to published, so the foreign row survives there too.
    const after = await service.getDraft();
    expect(after.draft[foreignPath]).toEqual(foreignDefault);
    expect(after.draft['general.fontSize']).toBeUndefined();
    expect(after.draft).toEqual(after.publishedPolicies);
    expect(after.draftToken).toBe(result.draftToken);
  });

  it('save ignores service-model paths in the payload and reports them as warnings', async () => {
    await seedForeignViaFullOwnership();
    const before = await service.getDraft();

    // Malicious / stale client tries to rewrite the foreign row through the policy editor.
    const result = await service.save({
      actorUserId: 'admin-policy',
      expectedDraftToken: before.draftToken,
      expectedRevision: before.baseRevision,
      policies: {
        [foreignPath]: foreignUpdated,
        'general.fontSize': {
          mode: 'locked',
          schemaVersion: 1,
          value: 20,
          visibility: 'hidden',
        },
      },
      reason: 'font only',
    });
    expect(result.warnings).toEqual(['ignored_service_model_paths:1']);

    const after = await service.getDraft();
    expect(after.publishedPolicies[foreignPath]).toEqual(foreignDefault);
    expect(after.publishedPolicies['general.fontSize']).toMatchObject({
      mode: 'locked',
      value: 20,
      visibility: 'hidden',
    });
  });

  // R5: a draft stranded by the pre-de-draft workflow must not be adopted silently.
  it('save starts from published and drops a stranded legacy draft', async () => {
    await seedForeignViaFullOwnership();
    // Simulate a legacy unpublished draft left behind by the removed workflow.
    await saveCurrentDraft(service, {
      actorUserId: 'admin-legacy',
      draft: {
        [foreignPath]: foreignDefault,
        'general.fontSize': { mode: 'locked', schemaVersion: 1, value: 22, visibility: 'hidden' },
        'general.isLiteMode': {
          mode: 'locked',
          schemaVersion: 1,
          value: true,
          visibility: 'hidden',
        },
      },
      ownership: 'policy-editor',
      reason: 'stranded legacy draft',
    });
    const stranded = await service.getDraft();
    expect(stranded.draft['general.isLiteMode']).toBeDefined();

    await service.save({
      actorUserId: 'admin-policy',
      expectedDraftToken: stranded.draftToken,
      expectedRevision: stranded.baseRevision,
      policies: {
        'general.fontSize': { mode: 'default', schemaVersion: 1, value: 16, visibility: 'visible' },
      },
      reason: 'save only what the editor sent',
    });

    const after = await service.getDraft();
    // The stranded path was never published and is not adopted by the save.
    expect(after.publishedPolicies['general.isLiteMode']).toBeUndefined();
    expect(after.draft['general.isLiteMode']).toBeUndefined();
    expect(after.publishedPolicies['general.fontSize']?.value).toBe(16);
    // Foreign row still intact.
    expect(after.publishedPolicies[foreignPath]).toEqual(foreignDefault);
  });

  it('full-owner publish can delete foreign service-model policies omitted from draft', async () => {
    await seedForeignViaFullOwnership();
    const before = await serverDB.select().from(platformSettingPolicies);
    expect(before.some((row) => row.path === foreignPath)).toBe(true);

    // Whole-table replacement: omit foreign path; only keep owned font.
    await saveCurrentDraft(service, {
      actorUserId: 'admin-sm',
      draft: {
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 16,
          visibility: 'visible',
        },
      },
      ownership: 'full',
      reason: 'full-owner delete foreign',
    });
    const afterSave = await service.getDraft();
    expect(afterSave.draft[foreignPath]).toBeUndefined();

    await service.publish({
      actorUserId: 'admin-sm',
      expectedDraftToken: afterSave.draftToken,
      expectedRevision: afterSave.baseRevision,
      ownership: 'full',
      reason: 'publish full-owner deletion',
    });

    const published = await serverDB.select().from(platformSettingPolicies);
    expect(published.find((row) => row.path === foreignPath)).toBeUndefined();
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'general.fontSize',
          value: 16,
        }),
      ]),
    );
  });

  it('partial save preserves foreign draft paths', async () => {
    await seedForeignViaFullOwnership();

    await saveCurrentDraft(service, {
      actorUserId: 'admin-policy',
      draft: {
        'general.fontSize': {
          mode: 'locked',
          schemaVersion: 1,
          value: 20,
          visibility: 'hidden',
        },
      },
      ownership: 'policy-editor',
      reason: 'partial owned save',
    });

    const draft = (await service.getDraft()).draft;
    expect(draft[foreignPath]).toEqual(foreignDefault);
    expect(draft['general.fontSize']).toMatchObject({
      mode: 'locked',
      value: 20,
      visibility: 'hidden',
    });
  });

  it('saving a visible setting leaves hidden default/visible foreign policies byte-identical', async () => {
    await seedForeignViaFullOwnership();
    const before = (await service.getDraft()).draft[foreignPath];

    // Malicious / stale client tries to rewrite foreign row to locked+hidden.
    await saveCurrentDraft(service, {
      actorUserId: 'admin-policy',
      draft: {
        [foreignPath]: {
          mode: 'locked',
          schemaVersion: 1,
          value: 99,
          visibility: 'hidden',
        },
        'general.fontSize': {
          mode: 'locked',
          schemaVersion: 1,
          value: 18,
          visibility: 'hidden',
        },
      },
      ownership: 'policy-editor',
      reason: 'font only',
    });

    const after = (await service.getDraft()).draft[foreignPath];
    expect(after).toEqual(before);
    expect(after).toEqual(foreignDefault);
  });

  it('rollback of an older policy-editor revision leaves newer service-model rows byte-identical', async () => {
    // v1: seed foreign + owned fontSize=16
    await seedForeignViaFullOwnership();
    expect((await service.getDraft()).baseRevision).toBe(1);

    // v2: policy-editor changes owned font only
    await saveCurrentDraft(service, {
      actorUserId: 'admin-policy',
      draft: {
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 22,
          visibility: 'visible',
        },
      },
      ownership: 'policy-editor',
      reason: 'policy-editor bump font',
    });
    const afterV2Save = await service.getDraft();
    await service.publish({
      actorUserId: 'admin-policy',
      expectedDraftToken: afterV2Save.draftToken,
      expectedRevision: afterV2Save.baseRevision,
      ownership: 'policy-editor',
      reason: 'publish policy-editor v2',
    });
    expect((await service.getDraft()).baseRevision).toBe(2);

    // After v2: service-model updates the foreign row (simulates applyImmediate / full save).
    await saveCurrentDraft(service, {
      actorUserId: 'admin-sm',
      draft: {
        [foreignPath]: foreignUpdated,
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 22,
          visibility: 'visible',
        },
      },
      ownership: 'full',
      reason: 'service-model update after policy revision',
    });
    const afterSmSave = await service.getDraft();
    await service.publish({
      actorUserId: 'admin-sm',
      expectedDraftToken: afterSmSave.draftToken,
      expectedRevision: afterSmSave.baseRevision,
      ownership: 'full',
      reason: 'publish newer service-model foreign',
    });
    expect((await service.getDraft()).baseRevision).toBe(3);

    const beforeRollback = await service.getDraft();
    expect(beforeRollback.publishedPolicies[foreignPath]).toEqual(foreignUpdated);

    // Rollback to v1 (policy-editor era with foreignDefault=4). Current foreign must stay.
    const rolled = await service.rollback({
      actorUserId: 'admin-policy',
      expectedDraftToken: beforeRollback.draftToken,
      expectedRevision: beforeRollback.baseRevision,
      reason: 'restore policy-editor v1 without clobbering service-model',
      targetRevision: 1,
    });
    expect(rolled.revision).toBe(4);

    const after = await service.getDraft();
    expect(after.baseRevision).toBe(4);
    // Owned path restored from historical v1.
    expect(after.publishedPolicies['general.fontSize']?.value).toBe(16);
    expect(after.draft['general.fontSize']?.value).toBe(16);
    // Newer service-model foreign row must remain byte-identical (not historical value 4).
    expect(after.publishedPolicies[foreignPath]).toEqual(foreignUpdated);
    expect(after.draft[foreignPath]).toEqual(foreignUpdated);
  });
});

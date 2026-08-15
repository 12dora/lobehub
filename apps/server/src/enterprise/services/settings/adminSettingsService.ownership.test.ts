// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformSettingsModel, type SettingsDraftPolicyMap } from '@/database/models/platform';
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

/**
 * Write the draft column directly. Every service write path now aligns the draft with
 * published, so this is the only way left to reproduce residue from the removed workflow.
 */
const strandLegacyDraft = (draft: SettingsDraftPolicyMap) =>
  new PlatformSettingsModel(serverDB).saveDraft({ draft, updatedBy: 'admin-legacy' });

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

  /** The service-model surface (applyImmediate) publishes the foreign row + an owned path. */
  const seedForeignViaServiceModel = async () => {
    await service.applyImmediate({
      actorUserId: 'admin-sm',
      patch: { [foreignPath]: 4, 'general.fontSize': 16 },
      reason: 'seed service-model + policy paths',
    });
  };

  // R1: the 空草稿 regression (926e53e8d7). An empty policy-editor payload is 恢复默认 for
  // OWNED paths only — it must never become a whole-table replacement.
  it('save with an empty policy map preserves foreign published rows', async () => {
    await seedForeignViaServiceModel();
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
    await seedForeignViaServiceModel();
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

  it('applyImmediate keeps owned published rows it does not patch', async () => {
    await seedForeignViaServiceModel();

    await service.applyImmediate({
      actorUserId: 'admin-sm',
      patch: { [foreignPath]: 8 },
      reason: 'service-model only touches its own path',
    });

    const after = await service.getDraft();
    expect(after.publishedPolicies[foreignPath]?.value).toBe(8);
    expect(after.publishedPolicies['general.fontSize']?.value).toBe(16);
    expect(after.draft).toEqual(after.publishedPolicies);
  });

  // R5: a draft stranded by the pre-de-draft workflow must not be adopted silently.
  it('save starts from published and drops a stranded legacy draft', async () => {
    await seedForeignViaServiceModel();
    // Simulate a legacy unpublished draft left behind by the removed workflow.
    await strandLegacyDraft({
      [foreignPath]: foreignDefault,
      'general.fontSize': { mode: 'locked', schemaVersion: 1, value: 22, visibility: 'hidden' },
      'general.isLiteMode': {
        mode: 'locked',
        schemaVersion: 1,
        value: true,
        visibility: 'hidden',
      },
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
});

// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import { platformAuditLogs, platformSettingPolicies } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformDependencyTargetNotPublishedError } from '../platformDependencyLock';
import {
  AdminSettingsService,
  SettingsDirtyDraftError,
  SettingsDraftValidationError,
} from './adminSettingsService';
import {
  EffectiveSettingsService,
  resetEffectiveSettingsCacheForTest,
} from './effectiveSettingsService';
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

const saveCurrentDraft = async (
  target: AdminSettingsService,
  params: Omit<Parameters<AdminSettingsService['saveDraft']>[0], 'expectedDraftToken'>,
) =>
  target.saveDraft({
    ...params,
    expectedDraftToken: (await target.getDraft()).draftToken,
  });

describe('AdminSettingsService.applyImmediate', () => {
  beforeEach(() => {
    resetEffectiveSettingsCacheForTest();
  });

  it('publishes patch paths and is readable via EffectiveSettingsService', async () => {
    const result = await service.applyImmediate({
      actorUserId: 'admin-1',
      patch: {
        'memory.enabled': false,
        'memory.effort': 'high',
      },
      reason: 'set memory defaults',
    });

    expect(result.revision).toBe(1);
    expect(result.paths).toEqual(['memory.effort', 'memory.enabled']);

    const policies = await serverDB.select().from(platformSettingPolicies);
    expect(policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: 'default',
          path: 'memory.enabled',
          value: false,
          visibility: 'visible',
        }),
        expect.objectContaining({
          mode: 'default',
          path: 'memory.effort',
          value: 'high',
        }),
      ]),
    );

    const effective = new EffectiveSettingsService(serverDB);
    const userState = await effective.getEffectiveSettings({ userId: 'user-1' });
    expect(userState.effectiveValues['memory.enabled']).toBe(false);
    expect(userState.effectiveValues['memory.effort']).toBe('high');

    const audits = await serverDB.select().from(platformAuditLogs);
    expect(
      audits.some(
        (row) => row.action === 'admin.settings.applyImmediate' && row.result === 'success',
      ),
    ).toBe(true);
  });

  it('rejects dirty draft outside the patch', async () => {
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 20,
          visibility: 'visible',
        },
      },
      reason: 'leave unpublished draft',
    });

    await expect(
      service.applyImmediate({
        actorUserId: 'admin-1',
        patch: { 'memory.enabled': true },
      }),
    ).rejects.toBeInstanceOf(SettingsDirtyDraftError);

    const policies = await serverDB.select().from(platformSettingPolicies);
    expect(policies).toEqual([]);

    const audits = await serverDB.select().from(platformAuditLogs);
    expect(
      audits.some(
        (row) => row.action === 'admin.settings.applyImmediate' && row.result === 'failure',
      ),
    ).toBe(true);
  });

  it('promotes mode user→default and keeps locked', async () => {
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'memory.enabled': {
          mode: 'user',
          schemaVersion: 1,
          value: true,
          visibility: 'visible',
        },
        'memory.effort': {
          mode: 'locked',
          schemaVersion: 1,
          value: 'low',
          visibility: 'hidden',
        },
      },
      reason: 'seed modes',
    });
    await service.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.getDraft()).draftToken,
      expectedRevision: 0,
      reason: 'publish seed',
    });

    await service.applyImmediate({
      actorUserId: 'admin-1',
      patch: {
        'memory.enabled': false,
        'memory.effort': 'high',
      },
    });

    const policies = await serverDB.select().from(platformSettingPolicies);
    expect(policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: 'default',
          path: 'memory.enabled',
          value: false,
          visibility: 'visible',
        }),
        expect.objectContaining({
          mode: 'locked',
          path: 'memory.effort',
          value: 'high',
          visibility: 'hidden',
        }),
      ]),
    );
  });

  it('rejects unknown registry paths', async () => {
    await expect(
      service.applyImmediate({
        actorUserId: 'admin-1',
        patch: { 'not.a.real.path': 1 },
      }),
    ).rejects.toBeInstanceOf(SettingsDraftValidationError);
  });

  it('registers service-model paths used by the admin forms', () => {
    const required = [
      'defaultAgent.config.model',
      'defaultAgent.config.provider',
      'memory.enabled',
      'memory.effort',
      'image.defaultImageNum',
      'tts.openAI.ttsModel',
      'systemAgent.topic.model',
      'systemAgent.topic.provider',
      'systemAgent.generationTopic.model',
      'systemAgent.generationTopic.provider',
      'systemAgent.translation.model',
      'systemAgent.translation.provider',
      'systemAgent.historyCompress.model',
      'systemAgent.historyCompress.provider',
      'systemAgent.agentMeta.model',
      'systemAgent.agentMeta.provider',
      'systemAgent.followUpAction.model',
      'systemAgent.followUpAction.provider',
      'systemAgent.followUpAction.enabled',
      'systemAgent.inputCompletion.model',
      'systemAgent.inputCompletion.provider',
      'systemAgent.inputCompletion.enabled',
      'systemAgent.promptRewrite.model',
      'systemAgent.promptRewrite.provider',
      'systemAgent.promptRewrite.enabled',
      'systemAgent.memoryAnalysisAgentConfig.model',
      'systemAgent.memoryAnalysisAgentConfig.provider',
      'systemAgent.memoryAnalysisAgentConfig.contextLimit',
      'systemAgent.userMemoryPersonaWriter.model',
      'systemAgent.userMemoryPersonaWriter.provider',
      'systemAgent.userMemoryPersonaWriter.contextLimit',
      'systemAgent.userMemoryEmbedding.model',
      'systemAgent.userMemoryEmbedding.provider',
      'systemAgent.userMemoryEmbedding.contextLimit',
    ];
    for (const path of required) {
      expect(settingsRegistry.has(path), path).toBe(true);
      expect(
        settingsRegistry.assertPathWritable({ path, requirePlatformEligible: true }),
      ).toBeNull();
    }
  });

  it('allows overwriting draft-vs-published diffs on paths inside the patch', async () => {
    // Path inside patch may already differ; only outside-path dirty drafts are rejected.
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'memory.enabled': {
          mode: 'default',
          schemaVersion: 1,
          value: true,
          visibility: 'visible',
        },
      },
      reason: 'seed draft-only memory',
    });

    await service.applyImmediate({
      actorUserId: 'admin-1',
      patch: { 'memory.enabled': false },
      reason: 'overwrite in-patch dirty path',
    });

    const policies = await serverDB.select().from(platformSettingPolicies);
    expect(policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'memory.enabled', value: false, mode: 'default' }),
      ]),
    );
  });

  it('uses published mode as basis (published locked + draft user → stays locked)', async () => {
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'memory.effort': {
          mode: 'locked',
          schemaVersion: 1,
          value: 'low',
          visibility: 'visible',
        },
      },
      reason: 'publish locked',
    });
    await service.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.getDraft()).draftToken,
      expectedRevision: 0,
      reason: 'publish locked effort',
    });

    // Policy page draft changes mode to user without publishing — applyImmediate must not adopt it.
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'memory.effort': {
          mode: 'user',
          schemaVersion: 1,
          value: 'low',
          visibility: 'visible',
        },
      },
      reason: 'unpublished mode edit on same path',
    });

    // Draft equals published on fingerprint except mode — wait, mode differs so dirty check
    // for paths outside patch would not apply (this path is inside patch). applyImmediate
    // overwrites value and mode based on published.
    await service.applyImmediate({
      actorUserId: 'admin-1',
      patch: { 'memory.effort': 'high' },
      reason: 'value bump keeps published locked',
    });

    const policies = await serverDB.select().from(platformSettingPolicies);
    expect(policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: 'locked',
          path: 'memory.effort',
          value: 'high',
        }),
      ]),
    );
  });

  it('restores prior draft with saved.draftToken after publish failure', async () => {
    // Force publish to fail after saveDraft by rejecting AI references on a model path.
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'memory.enabled': {
          mode: 'default',
          schemaVersion: 1,
          value: true,
          visibility: 'visible',
        },
      },
      reason: 'seed published memory',
    });
    await service.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.getDraft()).draftToken,
      expectedRevision: 0,
      reason: 'publish seed',
    });

    await expect(
      service.applyImmediate({
        actorUserId: 'admin-1',
        patch: {
          'systemAgent.topic.model': 'missing-model',
          'systemAgent.topic.provider': 'missing-provider',
        },
        reason: 'must fail AI reference publish',
      }),
    ).rejects.toBeInstanceOf(PlatformDependencyTargetNotPublishedError);

    // Restore should have returned draft to pre-applyImmediate state (memory only).
    const after = await service.getDraft();
    expect(after.draft).toEqual({
      'memory.enabled': {
        mode: 'default',
        schemaVersion: 1,
        value: true,
        visibility: 'visible',
      },
    });
    // Published unchanged (publish failed).
    expect(await serverDB.select().from(platformSettingPolicies)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'memory.enabled', value: true })]),
    );
  });

  it('does not overwrite concurrent draft when restore token mismatches', async () => {
    await saveCurrentDraft(service, {
      actorUserId: 'admin-1',
      draft: {
        'memory.enabled': {
          mode: 'default',
          schemaVersion: 1,
          value: true,
          visibility: 'visible',
        },
      },
      reason: 'seed',
    });
    await service.publish({
      actorUserId: 'admin-1',
      expectedDraftToken: (await service.getDraft()).draftToken,
      expectedRevision: 0,
      reason: 'publish seed',
    });

    // Sequence:
    // 1) applyImmediate saveDraft succeeds with nextDraft
    // 2) publish fails (AI ref not published)
    // 3) in restore window, concurrent admin saves a different draft with the post-step-1 token
    // 4) restore with saved.draftToken fails (token advanced) → concurrent draft preserved
    const concurrentDraft = {
      'memory.enabled': {
        mode: 'default' as const,
        schemaVersion: 1,
        value: true,
        visibility: 'visible' as const,
      },
      'general.fontSize': {
        mode: 'default' as const,
        schemaVersion: 1,
        value: 22,
        visibility: 'visible' as const,
      },
    };

    const originalSaveDraft = service.saveDraft.bind(service);
    let applySaveToken: string | undefined;
    const saveSpy = vi.spyOn(service, 'saveDraft').mockImplementation(async (params) => {
      if (!applySaveToken) {
        const result = await originalSaveDraft(params);
        applySaveToken = result.draftToken;
        return result;
      }

      // Restore attempt: race concurrent writer first with the apply save token.
      if (String(params.reason).includes('restore after publish failure')) {
        await originalSaveDraft({
          actorUserId: 'admin-2',
          draft: concurrentDraft,
          expectedDraftToken: applySaveToken,
          reason: 'concurrent policy edit',
        });
        // Restore must now fail with token mismatch (do not swallow).
        return originalSaveDraft(params);
      }

      return originalSaveDraft(params);
    });

    await expect(
      service.applyImmediate({
        actorUserId: 'admin-1',
        patch: {
          'systemAgent.topic.model': 'missing-model',
          'systemAgent.topic.provider': 'missing-provider',
        },
        reason: 'fail publish + concurrent restore race',
      }),
    ).rejects.toBeInstanceOf(PlatformDependencyTargetNotPublishedError);

    saveSpy.mockRestore();

    const current = await service.getDraft();
    // Concurrent draft must survive — restore abandoned due to token mismatch.
    expect(current.draft).toEqual(concurrentDraft);

    const audits = await serverDB.select().from(platformAuditLogs);
    expect(
      audits.some(
        (row) =>
          row.action === 'admin.settings.applyImmediate' &&
          row.result === 'failure' &&
          String(row.reason ?? '').includes('restore abandoned'),
      ),
    ).toBe(true);
  });
});

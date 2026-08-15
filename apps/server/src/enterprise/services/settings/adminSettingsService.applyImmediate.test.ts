// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformSettingsModel, type SettingsDraftPolicyMap } from '@/database/models/platform';
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

/**
 * Write the draft column directly. Both service write paths align the draft with
 * published, so this is the only way left to reproduce an unpublished draft.
 */
const strandLegacyDraft = (draft: SettingsDraftPolicyMap) =>
  new PlatformSettingsModel(serverDB).saveDraft({ draft, updatedBy: 'admin-legacy' });

/** Publish owned policy paths through the de-drafted write path. */
const publishPolicies = async (policies: SettingsDraftPolicyMap, reason: string) => {
  const base = await service.getDraft();
  return service.save({
    actorUserId: 'admin-1',
    expectedDraftToken: base.draftToken,
    expectedRevision: base.baseRevision,
    policies,
    reason,
  });
};

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
    await strandLegacyDraft({
      'general.fontSize': {
        mode: 'default',
        schemaVersion: 1,
        value: 20,
        visibility: 'visible',
      },
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
    await publishPolicies(
      {
        'memory.effort': {
          mode: 'locked',
          schemaVersion: 1,
          value: 'low',
          visibility: 'hidden',
        },
        'memory.enabled': {
          mode: 'user',
          schemaVersion: 1,
          value: true,
          visibility: 'visible',
        },
      },
      'seed modes',
    );

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
    await strandLegacyDraft({
      'memory.enabled': {
        mode: 'default',
        schemaVersion: 1,
        value: true,
        visibility: 'visible',
      },
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
    await publishPolicies(
      {
        'memory.effort': {
          mode: 'locked',
          schemaVersion: 1,
          value: 'low',
          visibility: 'visible',
        },
      },
      'publish locked effort',
    );

    // A stranded draft changes mode to user without publishing — applyImmediate must not adopt it.
    await strandLegacyDraft({
      'memory.effort': {
        mode: 'user',
        schemaVersion: 1,
        value: 'low',
        visibility: 'visible',
      },
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

  it('leaves draft and published untouched when the write fails mid-transaction', async () => {
    await publishPolicies(
      {
        'memory.enabled': {
          mode: 'default',
          schemaVersion: 1,
          value: true,
          visibility: 'visible',
        },
      },
      'publish seed',
    );
    const before = await service.getDraft();

    // Unpublished AI reference → the single transaction fails on materialize.
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

    // Nothing half-applied: same revision, same draft column, same published rows.
    const after = await service.getDraft();
    expect(after.baseRevision).toBe(before.baseRevision);
    expect(after.draftToken).toBe(before.draftToken);
    expect(after.draft).toEqual(before.draft);
    expect(await serverDB.select().from(platformSettingPolicies)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'memory.enabled', value: true })]),
    );
    expect(
      (await serverDB.select().from(platformSettingPolicies)).some((row) =>
        row.path.startsWith('systemAgent.'),
      ),
    ).toBe(false);
  });
});

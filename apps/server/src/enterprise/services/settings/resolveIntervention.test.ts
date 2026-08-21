// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformSettingPolicies,
  platformSettingsBundle,
  userSettingOverrideRevisions,
  userSettingOverrides,
} from '@/database/schemas/platform';
import { users, userSettings } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';
import {
  PLATFORM_SETTINGS_RESOURCE_ID,
  PLATFORM_SETTINGS_RESOURCE_TYPE,
} from '@/types/platform/settings';

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import { AdminSettingsService } from './adminSettingsService';
import {
  EffectiveSettingsService,
  resetEffectiveSettingsCacheForTest,
} from './effectiveSettingsService';
import {
  resolveEffectiveUserInterventionConfig,
  resolvePersonalTopicApprovalSnapshot,
} from './runtimeSettingsAdapter';

const { policyState } = vi.hoisted(() => ({ policyState: { enabled: true } }));

vi.mock('../../featureFlags', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getDefaultEnterpriseFeatureFlags: () => Record<string, boolean>;
  };
  return {
    ...actual,
    getEnterpriseFeatureFlags: vi.fn(() => ({
      ...actual.getDefaultEnterpriseFeatureFlags(),
      ENABLE_PLATFORM_SETTINGS_POLICY: policyState.enabled,
    })),
  };
});

const serverDB: LobeChatDatabase = await getTestDB();
const FIXTURE_ACTOR_IDS = ['admin'] as const;

beforeEach(async () => {
  policyState.enabled = true;
  // Drop process-local policy caches so revision numbers recycled after cleanup
  // cannot serve a previous test's published policies (e.g. locked → default).
  resetEffectiveSettingsCacheForTest();
  await deletePlatformAuditLogsForTest(serverDB, { actorUserIds: FIXTURE_ACTOR_IDS });
  await deletePlatformResourceRevisionsForTest(serverDB, {
    resourceIds: [PLATFORM_SETTINGS_RESOURCE_ID],
    resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
  });
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(userSettings);
  await serverDB.delete(users);
  await serverDB
    .insert(users)
    .values([{ id: 'u-locked' }, { id: 'u-personal' }, { id: 'u-workspace' }]);
});

afterEach(async () => {
  resetEffectiveSettingsCacheForTest();
  await deletePlatformAuditLogsForTest(serverDB, { actorUserIds: FIXTURE_ACTOR_IDS });
  await deletePlatformResourceRevisionsForTest(serverDB, {
    resourceIds: [PLATFORM_SETTINGS_RESOURCE_ID],
    resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
  });
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(userSettings);
  await serverDB.delete(users);
});

describe('resolveEffectiveUserInterventionConfig (R3-B1)', () => {
  it('forces platform locked approvalMode over caller headless', async () => {
    const admin = new AdminSettingsService(serverDB);
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        'tool.humanIntervention.approvalMode': {
          mode: 'locked',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'visible',
        },
      },
      reason: 'p',
    });

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: { approvalMode: 'headless' },
      db: serverDB,
      userId: 'u-locked',
    });
    expect(resolved?.approvalMode).toBe('manual');
  });

  it('uses a permitted personal override when platform mode is default', async () => {
    const admin = new AdminSettingsService(serverDB);
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        'tool.humanIntervention.approvalMode': {
          mode: 'default',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'visible',
        },
      },
      reason: 'publish',
    });
    await new EffectiveSettingsService(serverDB).patchSettingOverride({
      client: 'web',
      path: 'tool.humanIntervention.approvalMode',
      userId: 'u-personal',
      value: 'auto-run',
    });

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: { approvalMode: 'headless' },
      db: serverDB,
      userId: 'u-personal',
    });
    expect(resolved).toEqual({ approvalMode: 'auto-run', allowList: undefined });
  });

  it('excludes personal overrides from workspace execution', async () => {
    const admin = new AdminSettingsService(serverDB);
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        'tool.humanIntervention.approvalMode': {
          mode: 'default',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'visible',
        },
      },
      reason: 'publish',
    });
    await new EffectiveSettingsService(serverDB).patchSettingOverride({
      client: 'web',
      path: 'tool.humanIntervention.approvalMode',
      userId: 'u-workspace',
      value: 'auto-run',
    });

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: { approvalMode: 'headless' },
      db: serverDB,
      scope: 'workspace',
      userId: 'u-workspace',
    });
    expect(resolved?.approvalMode).toBe('manual');
  });

  it('overlays a topic snapshot over a personal override when not locked', async () => {
    const admin = new AdminSettingsService(serverDB);
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        'tool.humanIntervention.approvalMode': {
          mode: 'default',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'visible',
        },
      },
      reason: 'publish',
    });
    await new EffectiveSettingsService(serverDB).patchSettingOverride({
      client: 'web',
      path: 'tool.humanIntervention.approvalMode',
      userId: 'u-personal',
      value: 'auto-run',
    });

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: { allowList: ['safe/tool'], approvalMode: 'auto-run' },
      db: serverDB,
      topicApprovalMode: 'allow-list',
      userId: 'u-personal',
    });
    expect(resolved).toEqual({ allowList: ['safe/tool'], approvalMode: 'allow-list' });
  });

  it('keeps a platform-locked approvalMode over a topic snapshot', async () => {
    const admin = new AdminSettingsService(serverDB);
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        'tool.humanIntervention.approvalMode': {
          mode: 'locked',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'hidden',
        },
      },
      reason: 'p',
    });

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: { approvalMode: 'auto-run' },
      db: serverDB,
      topicApprovalMode: 'auto-run',
      userId: 'u-locked',
    });
    expect(resolved?.approvalMode).toBe('manual');
  });

  it('does not overlay topic mode on workspace execution', async () => {
    const admin = new AdminSettingsService(serverDB);
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        'tool.humanIntervention.approvalMode': {
          mode: 'default',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'visible',
        },
      },
      reason: 'publish',
    });

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: { approvalMode: 'auto-run' },
      db: serverDB,
      scope: 'workspace',
      topicApprovalMode: 'allow-list',
      userId: 'u-workspace',
    });
    expect(resolved?.approvalMode).toBe('manual');
  });

  it('flag OFF overlays a topic snapshot for interactive callers', async () => {
    policyState.enabled = false;

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: { allowList: ['safe/tool'], approvalMode: 'manual' },
      db: serverDB,
      topicApprovalMode: 'auto-run',
      userId: 'u-off',
    });
    expect(resolved).toEqual({ allowList: ['safe/tool'], approvalMode: 'auto-run' });
  });

  it('flag OFF ignores a topic snapshot for headless callers', async () => {
    policyState.enabled = false;
    const caller = { approvalMode: 'headless' as const };

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: caller,
      db: serverDB,
      topicApprovalMode: 'manual',
      userId: 'u-off',
    });
    expect(resolved).toBe(caller);
  });

  it('flag OFF returns the caller object unchanged without touching the database', async () => {
    policyState.enabled = false;
    const caller = { allowList: ['safe/tool'], approvalMode: 'allow-list' as const };
    const dbThatMustNotBeRead = new Proxy(
      {},
      {
        get() {
          throw new Error('database accessed while feature flag is off');
        },
      },
    ) as LobeChatDatabase;

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: caller,
      db: dbThatMustNotBeRead,
      userId: 'u-off',
    });
    expect(resolved).toBe(caller);
  });
});

describe('resolvePersonalTopicApprovalSnapshot', () => {
  it('falls back to built-in manual when the client omits a mode', async () => {
    const snapshot = await resolvePersonalTopicApprovalSnapshot({
      db: serverDB,
      userId: 'u-personal',
    });
    expect(snapshot).toEqual({ runtimeMode: 'manual', snapshotMode: 'manual' });
  });

  it('uses the client-supplied topic layer when the platform is not locked', async () => {
    const snapshot = await resolvePersonalTopicApprovalSnapshot({
      clientApprovalMode: 'auto-run',
      db: serverDB,
      userId: 'u-personal',
    });
    expect(snapshot).toEqual({ runtimeMode: 'auto-run', snapshotMode: 'auto-run' });
  });

  it('uses a personal override when the client omits a mode', async () => {
    const admin = new AdminSettingsService(serverDB);
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        'tool.humanIntervention.approvalMode': {
          mode: 'default',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'visible',
        },
      },
      reason: 'publish',
    });
    await new EffectiveSettingsService(serverDB).patchSettingOverride({
      client: 'web',
      path: 'tool.humanIntervention.approvalMode',
      userId: 'u-personal',
      value: 'auto-run',
    });

    const snapshot = await resolvePersonalTopicApprovalSnapshot({
      db: serverDB,
      userId: 'u-personal',
    });
    expect(snapshot).toEqual({ runtimeMode: 'auto-run', snapshotMode: 'auto-run' });
  });

  it('lets a platform-locked policy override client-supplied initial metadata', async () => {
    const admin = new AdminSettingsService(serverDB);
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        'tool.humanIntervention.approvalMode': {
          mode: 'locked',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'hidden',
        },
      },
      reason: 'p',
    });

    const snapshot = await resolvePersonalTopicApprovalSnapshot({
      clientApprovalMode: 'auto-run',
      db: serverDB,
      userId: 'u-locked',
    });
    expect(snapshot).toEqual({ runtimeMode: 'manual', snapshotMode: 'manual' });
  });

  it('returns no snapshotMode when user settings store headless (never persist it)', async () => {
    policyState.enabled = false;
    await serverDB.insert(userSettings).values({
      id: 'u-personal',
      tool: { humanIntervention: { approvalMode: 'headless' } },
    });

    const snapshot = await resolvePersonalTopicApprovalSnapshot({
      db: serverDB,
      userId: 'u-personal',
    });
    expect(snapshot).toEqual({ runtimeMode: 'headless', snapshotMode: undefined });
  });

  it('returns no snapshotMode when a platform lock to headless would otherwise snapshot', async () => {
    const admin = new AdminSettingsService(serverDB);
    const base = await admin.getDraft();
    await admin.save({
      actorUserId: 'admin',
      expectedDraftToken: base.draftToken,
      expectedRevision: base.baseRevision,
      policies: {
        'tool.humanIntervention.approvalMode': {
          mode: 'locked',
          schemaVersion: 1,
          value: 'headless',
          visibility: 'hidden',
        },
      },
      reason: 'p',
    });

    const snapshot = await resolvePersonalTopicApprovalSnapshot({
      clientApprovalMode: 'auto-run',
      db: serverDB,
      userId: 'u-locked',
    });
    expect(snapshot).toEqual({ runtimeMode: 'headless', snapshotMode: undefined });
  });

  it('flag OFF uses the user_settings preference when the client omits a mode', async () => {
    policyState.enabled = false;
    await serverDB.insert(userSettings).values({
      id: 'u-personal',
      tool: { humanIntervention: { approvalMode: 'allow-list' } },
    });

    const snapshot = await resolvePersonalTopicApprovalSnapshot({
      db: serverDB,
      userId: 'u-personal',
    });
    expect(snapshot).toEqual({ runtimeMode: 'allow-list', snapshotMode: 'allow-list' });
  });
});

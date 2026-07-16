// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
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

import { AdminSettingsService } from './adminSettingsService';
import { EffectiveSettingsService } from './effectiveSettingsService';
import { resolveEffectiveUserInterventionConfig } from './runtimeSettingsAdapter';

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

beforeEach(async () => {
  policyState.enabled = true;
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(users);
  await serverDB
    .insert(users)
    .values([{ id: 'u-locked' }, { id: 'u-personal' }, { id: 'u-workspace' }]);
});

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(users);
});

describe('resolveEffectiveUserInterventionConfig (R3-B1)', () => {
  it('forces platform locked approvalMode over caller headless', async () => {
    const admin = new AdminSettingsService(serverDB);
    await admin.saveDraft({
      actorUserId: 'admin',
      draft: {
        'tool.humanIntervention.approvalMode': {
          mode: 'locked',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'visible',
        },
      },
      reason: 'lock',
    });
    await admin.publish({ actorUserId: 'admin', expectedRevision: 0, reason: 'p' });

    const resolved = await resolveEffectiveUserInterventionConfig({
      callerConfig: { approvalMode: 'headless' },
      db: serverDB,
      userId: 'u-locked',
    });
    expect(resolved?.approvalMode).toBe('manual');
  });

  it('uses a permitted personal override when platform mode is default', async () => {
    const admin = new AdminSettingsService(serverDB);
    await admin.saveDraft({
      actorUserId: 'admin',
      draft: {
        'tool.humanIntervention.approvalMode': {
          mode: 'default',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'visible',
        },
      },
      reason: 'default',
    });
    await admin.publish({ actorUserId: 'admin', expectedRevision: 0, reason: 'publish' });
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
    await admin.saveDraft({
      actorUserId: 'admin',
      draft: {
        'tool.humanIntervention.approvalMode': {
          mode: 'default',
          schemaVersion: 1,
          value: 'manual',
          visibility: 'visible',
        },
      },
      reason: 'default',
    });
    await admin.publish({ actorUserId: 'admin', expectedRevision: 0, reason: 'publish' });
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

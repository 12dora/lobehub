// @vitest-environment node
/**
 * B3-R2 causal concurrency: publish lock and user patch share bundle FOR UPDATE.
 * After a path is locked by publish, concurrent patch must fail closed.
 */
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
import type { LobeChatDatabase } from '@/database/type';

import { AdminSettingsService } from './adminSettingsService';
import { EffectiveSettingsService, SettingsPathError } from './effectiveSettingsService';

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
const admin = new AdminSettingsService(serverDB);
const userSvc = new EffectiveSettingsService(serverDB);

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

describe('B3-R2 TOCTOU lock vs publish', () => {
  it('patch fails closed after path is published as locked', async () => {
    await admin.saveDraft({
      actorUserId: 'admin',
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
    await admin.publish({ actorUserId: 'admin', expectedRevision: 0, reason: 'p1' });

    // user can patch while unlocked
    await userSvc.patchSettingOverride({
      client: 'web',
      path: 'memory.enabled',
      userId: 'u1',
      value: false,
    });

    // admin locks
    await admin.saveDraft({
      actorUserId: 'admin',
      draft: {
        'memory.enabled': {
          mode: 'locked',
          schemaVersion: 1,
          value: true,
          visibility: 'visible',
        },
      },
      reason: 'lock',
    });
    await admin.publish({ actorUserId: 'admin', expectedRevision: 1, reason: 'p2' });

    await expect(
      userSvc.patchSettingOverride({
        client: 'web',
        path: 'memory.enabled',
        userId: 'u1',
        value: false,
      }),
    ).rejects.toBeInstanceOf(SettingsPathError);
  });
});

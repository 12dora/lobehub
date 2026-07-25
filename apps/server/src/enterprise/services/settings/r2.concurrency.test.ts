// @vitest-environment node
/**
 * R3-B3 causal race: two DB clients share FOR UPDATE on settings bundle.
 * Sequence: T1 locks bundle (simulating publish materialization), T2 patch waits
 * on lock, T1 commits locked policy, T2 rechecks and fails closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformSettingPolicies,
  platformSettingsBundle,
  userSettingOverrideRevisions,
  userSettingOverrides,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';
import {
  PLATFORM_SETTINGS_RESOURCE_ID,
  PLATFORM_SETTINGS_RESOURCE_TYPE,
} from '@/types/platform/settings';

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const FIXTURE_ACTOR_IDS = ['admin'] as const;

beforeEach(async () => {
  await deletePlatformAuditLogsForTest(serverDB, { actorUserIds: FIXTURE_ACTOR_IDS });
  await deletePlatformResourceRevisionsForTest(serverDB, {
    resourceIds: [PLATFORM_SETTINGS_RESOURCE_ID],
    resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
  });
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(users);
  await serverDB.insert(users).values({ id: 'u-race' });
});

afterEach(async () => {
  await deletePlatformAuditLogsForTest(serverDB, { actorUserIds: FIXTURE_ACTOR_IDS });
  await deletePlatformResourceRevisionsForTest(serverDB, {
    resourceIds: [PLATFORM_SETTINGS_RESOURCE_ID],
    resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
  });
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(users);
});

describe('R3-B3 TOCTOU / shared lock ordering', () => {
  it('patch after concurrent lock publish cannot commit prohibited override', async () => {
    const publishInvalidation = {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformConfigInvalidationPublisher;
    const userInvalidation = {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformConfigInvalidationPublisher;
    const materialized = deferred();
    const releasePublish = deferred();
    const beforePatchLock = deferred();
    const releaseBeforePatchLock = deferred();
    const patchLockAcquired = deferred();
    const events: string[] = [];
    let acquired = false;
    let holdPublish = false;
    const admin = new AdminSettingsService(serverDB, {
      invalidation: publishInvalidation,
      lifecycle: {
        afterMaterialization: async (operation) => {
          if (operation !== 'publish' || !holdPublish) return;
          materialized.resolve();
          await releasePublish.promise;
        },
      },
    });
    const userSvc = new EffectiveSettingsService(serverDB, userInvalidation, {
      beforeBundleLock: async (operation) => {
        if (operation !== 'patch') return;
        events.push('before-patch-lock');
        beforePatchLock.resolve();
        await releaseBeforePatchLock.promise;
      },
      afterBundleLock: async (operation) => {
        if (operation !== 'patch') return;
        acquired = true;
        events.push('patch-lock-acquired');
        patchLockAcquired.resolve();
      },
    });

    const initialToken = (await admin.getDraft()).draftToken;
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
      expectedDraftToken: initialToken,
      reason: 'seed',
    });
    await admin.publish({
      actorUserId: 'admin',
      expectedDraftToken: (await admin.getDraft()).draftToken,
      expectedRevision: 0,
      reason: 'p1',
    });

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
      expectedDraftToken: (await admin.getDraft()).draftToken,
      reason: 'lock',
    });

    holdPublish = true;
    const publish = admin.publish({
      actorUserId: 'admin',
      expectedDraftToken: (await admin.getDraft()).draftToken,
      expectedRevision: 1,
      reason: 'p2',
    });
    await materialized.promise;

    // The patch transaction starts while publish still holds the bundle lock.
    const patch = userSvc.patchSettingOverride({
      client: 'web',
      path: 'memory.enabled',
      userId: 'u-race',
      value: false,
    });

    events.push('release-publish');
    releasePublish.resolve();
    await publish;
    await beforePatchLock.promise;

    // The hook is now inside the checked-out transaction. The old placement
    // outside db.transaction records `before-patch-lock` before `release-publish`
    // and fails this causal assertion.
    expect(events).toEqual(['release-publish', 'before-patch-lock']);
    expect(acquired).toBe(false);

    releaseBeforePatchLock.resolve();
    await patchLockAcquired.promise;
    expect(events).toEqual(['release-publish', 'before-patch-lock', 'patch-lock-acquired']);
    await expect(patch).rejects.toMatchObject({
      code: 'MANAGED_SETTING_BY_ADMIN',
      name: SettingsPathError.name,
    });

    const rows = await serverDB.select().from(userSettingOverrides);
    expect(rows).toEqual([]);
    expect(userInvalidation.publish).not.toHaveBeenCalled();
    expect(publishInvalidation.publish).toHaveBeenCalledTimes(2);
  });
});

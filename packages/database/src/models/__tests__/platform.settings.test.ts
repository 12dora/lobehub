// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { users } from '../../schemas';
import { userSettingOverrideRevisions, userSettingOverrides } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { AdminUserModel } from '../adminUser';
import { PlatformRevisionModel } from '../platform/revision';
import {
  createSettingsPointerAdapter,
  PLATFORM_SETTINGS_BUNDLE_ID,
  PlatformSettingsModel,
} from '../platform/settings';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformSettingsModel(serverDB);

const cleanup = async () => {
  // TRUNCATE bypasses row-level immutability triggers (migration 0145).
  await serverDB.execute(
    sql.raw(`
      TRUNCATE TABLE
        platform_audit_logs,
        platform_resource_revisions,
        user_setting_overrides,
        user_setting_override_revisions,
        platform_setting_policies,
        platform_settings_bundle
      CASCADE
    `),
  );
  await serverDB
    .delete(users)
    .where(sql`${users.id} IN ('user-a', 'user-b', 'u1', 'u2', 'cascade-user')`);
};

beforeEach(cleanup);
afterEach(cleanup);

const ensureUsers = async (...ids: string[]) => {
  for (const id of ids) {
    await serverDB
      .insert(users)
      .values({ id, username: id })
      .onConflictDoNothing({ target: users.id });
  }
};

describe('PlatformSettingsModel', () => {
  it('ensures singleton bundle and saves draft', async () => {
    const bundle = await model.ensureBundle();
    expect(bundle.id).toBe(PLATFORM_SETTINGS_BUNDLE_ID);
    expect(bundle.revision).toBe(0);

    const saved = await model.saveDraft({
      draft: {
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 18,
          visibility: 'visible',
        },
      },
      updatedBy: 'admin-1',
    });
    expect(saved.draft['general.fontSize']?.value).toBe(18);
  });

  it('replacePublishedPolicies upserts and deletes removed paths', async () => {
    await model.replacePublishedPolicies({
      draft: {
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 16,
          visibility: 'visible',
        },
        'memory.enabled': {
          mode: 'locked',
          schemaVersion: 1,
          value: true,
          visibility: 'visible',
        },
      },
      revision: 1,
      updatedBy: 'admin-1',
    });

    let policies = await model.listPublishedPolicies();
    expect(policies).toHaveLength(2);

    await model.replacePublishedPolicies({
      draft: {
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 18,
          visibility: 'hidden',
        },
      },
      revision: 2,
      updatedBy: 'admin-1',
    });

    policies = await model.listPublishedPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0]?.path).toBe('general.fontSize');
    expect(policies[0]?.visibility).toBe('hidden');
    expect(policies[0]?.value).toBe(18);
  });

  it('user overrides isolate by userId and bump revision on last delete', async () => {
    await ensureUsers('user-a', 'user-b');
    await model.upsertUserOverride({
      path: 'general.fontSize',
      userId: 'user-a',
      value: 16,
    });
    await model.upsertUserOverride({
      path: 'general.fontSize',
      userId: 'user-b',
      value: 20,
    });

    const a = await model.listUserOverrides('user-a');
    const b = await model.listUserOverrides('user-b');
    expect(a).toHaveLength(1);
    expect(a[0]?.value).toBe(16);
    expect(b[0]?.value).toBe(20);

    const revBefore = await model.getUserOverrideRevision('user-a');
    const del = await model.deleteUserOverride('user-a', 'general.fontSize');
    expect(del.deleted).toBe(true);
    expect(del.revision).toBeGreaterThan(revBefore);
    expect(await model.listUserOverrides('user-a')).toHaveLength(0);
    // user-b untouched
    expect(await model.listUserOverrides('user-b')).toHaveLength(1);
  });

  it('countOverridesByPaths uses aggregate query (no user scan)', async () => {
    await ensureUsers('u1', 'u2');
    await model.upsertUserOverride({ path: 'general.fontSize', userId: 'u1', value: 16 });
    await model.upsertUserOverride({ path: 'general.fontSize', userId: 'u2', value: 18 });
    await model.upsertUserOverride({ path: 'memory.enabled', userId: 'u1', value: false });

    const impact = await model.countOverridesByPaths(['general.fontSize', 'memory.enabled']);
    expect(impact.pathsWithOverrides).toBe(2);
    expect(impact.totalOverrideRows).toBe(3);
  });

  it('pointer adapter supports concurrent expectedRevision publish', async () => {
    await model.ensureBundle();
    const revisions = new PlatformRevisionModel(serverDB);
    const pointer = createSettingsPointerAdapter();

    await revisions.publishDraft({
      actorUserId: 'admin',
      expectedRevision: 0,
      payload: { policies: {}, registryVersion: 1 },
      pointer,
      reason: 'first',
      resourceId: 'global',
      resourceType: 'settings',
    });

    await expect(
      revisions.publishDraft({
        actorUserId: 'admin',
        expectedRevision: 0,
        payload: { policies: {}, registryVersion: 1 },
        pointer,
        reason: 'stale',
        resourceId: 'global',
        resourceType: 'settings',
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_REVISION_CONFLICT' });

    const ok = await revisions.publishDraft({
      actorUserId: 'admin',
      expectedRevision: 1,
      payload: {
        policies: {
          'general.fontSize': {
            mode: 'default',
            schemaVersion: 1,
            value: 18,
            visibility: 'visible',
          },
        },
        registryVersion: 1,
      },
      pointer,
      reason: 'second',
      resourceId: 'global',
      resourceType: 'settings',
    });
    expect(ok.revision.revision).toBe(2);
  });

  it('rollback appends new head without mutating history', async () => {
    await model.ensureBundle();
    const revisions = new PlatformRevisionModel(serverDB);
    const pointer = createSettingsPointerAdapter();

    await revisions.publishDraft({
      expectedRevision: 0,
      payload: { policies: { a: 1 }, registryVersion: 1 },
      pointer,
      resourceId: 'global',
      resourceType: 'settings',
    });
    await revisions.publishDraft({
      expectedRevision: 1,
      payload: { policies: { a: 2 }, registryVersion: 1 },
      pointer,
      resourceId: 'global',
      resourceType: 'settings',
    });

    const rolled = await revisions.rollbackToRevision({
      expectedRevision: 2,
      pointer,
      reason: 'rollback to v1',
      resourceId: 'global',
      resourceType: 'settings',
      targetRevision: 1,
    });
    expect(rolled.revision.revision).toBe(3);
    expect(rolled.revision.payload).toMatchObject({ policies: { a: 1 } });

    const history = await revisions.listRevisions('settings', 'global');
    expect(history).toHaveLength(3);
    // Original rev 1 payload unchanged
    const rev1 = history.find((r) => r.revision === 1);
    expect(rev1?.payload).toMatchObject({ policies: { a: 1 } });
    const rev2 = history.find((r) => r.revision === 2);
    expect(rev2?.payload).toMatchObject({ policies: { a: 2 } });
  });

  it('cascades user setting overrides and revisions on hard user delete', async () => {
    await ensureUsers('cascade-user');
    await model.upsertUserOverride({
      path: 'general.fontSize',
      userId: 'cascade-user',
      value: 22,
    });
    await model.upsertUserOverride({
      path: 'memory.enabled',
      userId: 'cascade-user',
      value: true,
    });
    // Ensure revision row exists
    expect(await model.getUserOverrideRevision('cascade-user')).toBeGreaterThan(0);

    const deleted = await new AdminUserModel(serverDB).hardDeleteUser('cascade-user');
    expect(deleted).toBe(true);

    const overrides = await serverDB
      .select()
      .from(userSettingOverrides)
      .where(sql`${userSettingOverrides.userId} = 'cascade-user'`);
    const revs = await serverDB
      .select()
      .from(userSettingOverrideRevisions)
      .where(sql`${userSettingOverrideRevisions.userId} = 'cascade-user'`);
    expect(overrides).toHaveLength(0);
    expect(revs).toHaveLength(0);
  });
});

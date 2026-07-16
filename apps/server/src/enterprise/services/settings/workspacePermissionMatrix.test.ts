// @vitest-environment node
import { WORKSPACE_SYSTEM_ROLES } from '@lobechat/const/rbac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformSettingsModel } from '@/database/models/platform';
import { UserModel } from '@/database/models/user';
import {
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
  platformSettingsBundle,
  userSettingOverrideRevisions,
  userSettingOverrides,
} from '@/database/schemas/platform';
import { permissions, rolePermissions, roles, userRoles } from '@/database/schemas/rbac';
import { users, userSettings } from '@/database/schemas/user';
import { workspaces } from '@/database/schemas/workspace';
import type { LobeChatDatabase } from '@/database/type';
import { assignWorkspaceRoleToUser, seedWorkspaceRoles } from '@/database/utils/seedWorkspaceRoles';
import { userRouter } from '@/server/routers/lambda/user';

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

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => serverDB),
}));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({})),
}));

const workspaceId = 'ws-settings-matrix';
const actorIds = {
  admin: 'settings-admin',
  member: 'settings-member',
  nonMember: 'settings-non-member',
  owner: 'settings-owner',
  viewer: 'settings-viewer',
} as const;

type Actor = keyof typeof actorIds;
const actors = Object.keys(actorIds) as Actor[];

const cleanup = async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(userSettingOverrides);
  await serverDB.delete(userSettingOverrideRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  await serverDB.delete(userSettings);
  await serverDB.delete(userRoles);
  await serverDB.delete(rolePermissions);
  await serverDB.delete(roles);
  await serverDB.delete(permissions);
  await serverDB.delete(workspaces);
  await serverDB.delete(users);
};

beforeEach(async () => {
  await cleanup();
  await serverDB.insert(users).values(actors.map((actor) => ({ id: actorIds[actor] })));
  await serverDB.insert(workspaces).values({
    id: workspaceId,
    name: 'Settings matrix',
    primaryOwnerId: actorIds.owner,
    slug: 'settings-matrix',
  });
  await seedWorkspaceRoles(serverDB, workspaceId);
  await assignWorkspaceRoleToUser(serverDB, {
    roleName: WORKSPACE_SYSTEM_ROLES.OWNER,
    userId: actorIds.owner,
    workspaceId,
  });
  await assignWorkspaceRoleToUser(serverDB, {
    roleName: WORKSPACE_SYSTEM_ROLES.MEMBER,
    userId: actorIds.member,
    workspaceId,
  });
  await assignWorkspaceRoleToUser(serverDB, {
    roleName: WORKSPACE_SYSTEM_ROLES.VIEWER,
    userId: actorIds.viewer,
    workspaceId,
  });

  // A custom workspace admin exercises permission-based behavior instead of a
  // hard-coded role name. It can manage workspace settings and member content.
  const adminPermissionRows = await serverDB
    .select()
    .from(permissions)
    .then((rows) =>
      rows.filter((row) => ['agent:update:all', 'workspace:update:all'].includes(row.code)),
    );
  const [adminRole] = await serverDB
    .insert(roles)
    .values({
      displayName: 'Settings Admin',
      isActive: true,
      isSystem: false,
      name: 'workspace_settings_admin',
      workspaceId,
    })
    .returning();
  await serverDB.insert(rolePermissions).values(
    adminPermissionRows.map((permission) => ({
      permissionId: permission.id,
      roleId: adminRole.id,
    })),
  );
  await serverDB.insert(userRoles).values({
    roleId: adminRole.id,
    userId: actorIds.admin,
    workspaceId,
  });
});

afterEach(cleanup);

const callerFor = (actor: Actor) =>
  userRouter.createCaller({
    serverDB,
    userId: actorIds[actor],
    workspaceId,
  } as never);

describe('workspace settings mutation permission matrix', () => {
  it.each(actors)('owner-tier patch: %s', async (actor) => {
    const allowed = actor === 'owner' || actor === 'admin';
    const mutation = callerFor(actor).patchSettingOverride({
      path: 'memory.enabled',
      value: false,
    });
    if (allowed) await expect(mutation).resolves.toMatchObject({ path: 'memory.enabled' });
    else await expect(mutation).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const row = await new PlatformSettingsModel(serverDB).getUserOverride(
      actorIds[actor],
      'memory.enabled',
    );
    expect(row?.value).toBe(allowed ? false : undefined);
  });

  it.each(actors)('member-tier patch: %s', async (actor) => {
    const allowed = actor === 'owner' || actor === 'admin' || actor === 'member';
    const mutation = callerFor(actor).patchSettingOverride({
      path: 'tool.humanIntervention.approvalMode',
      value: 'manual',
    });
    if (allowed) {
      await expect(mutation).resolves.toMatchObject({
        path: 'tool.humanIntervention.approvalMode',
      });
    } else {
      await expect(mutation).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    const row = await new PlatformSettingsModel(serverDB).getUserOverride(
      actorIds[actor],
      'tool.humanIntervention.approvalMode',
    );
    expect(row?.value).toBe(allowed ? 'manual' : undefined);
  });

  it.each(actors)('single owner-tier reset: %s', async (actor) => {
    const allowed = actor === 'owner' || actor === 'admin';
    const model = new PlatformSettingsModel(serverDB);
    await model.upsertUserOverride({
      path: 'memory.enabled',
      userId: actorIds[actor],
      value: false,
    });
    await model.upsertUserOverride({
      path: 'general.fontSize',
      userId: actorIds[actor],
      value: 17,
    });

    const mutation = callerFor(actor).resetSettingOverride({ path: 'memory.enabled' });
    if (allowed) await expect(mutation).resolves.toMatchObject({ deleted: true });
    else await expect(mutation).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const [target, unrelated] = await Promise.all([
      model.getUserOverride(actorIds[actor], 'memory.enabled'),
      model.getUserOverride(actorIds[actor], 'general.fontSize'),
    ]);
    if (allowed) expect(target).toBeUndefined();
    else expect(target).toMatchObject({ value: false });
    expect(unrelated?.value).toBe(17);
  });

  it.each(actors)('full reset: %s', async (actor) => {
    const allowed = actor === 'owner' || actor === 'admin';
    const userId = actorIds[actor];
    const model = new PlatformSettingsModel(serverDB);
    await new UserModel(serverDB, userId).updateSetting({
      general: { fontSize: 16 },
      keyVaults: `encrypted-${actor}`,
    });
    await model.upsertUserOverride({ path: 'general.fontSize', userId, value: 17 });
    await model.upsertUserOverride({ path: 'memory.enabled', userId, value: false });

    const mutation = callerFor(actor).resetSettings();
    if (allowed) await expect(mutation).resolves.toBeUndefined();
    else await expect(mutation).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const [settings, overrides] = await Promise.all([
      new UserModel(serverDB, userId).getUserSettings(),
      model.listUserOverrides(userId),
    ]);
    if (allowed) expect(settings).toBeUndefined();
    else expect(settings).toMatchObject({ keyVaults: `encrypted-${actor}` });
    expect(overrides).toHaveLength(allowed ? 0 : 2);
  });
});

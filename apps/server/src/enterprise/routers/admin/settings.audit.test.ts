// @vitest-environment node
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
  platformSettingsBundle,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createContextInner } from '@/libs/trpc/lambda/context';
import {
  PLATFORM_SETTINGS_RESOURCE_ID,
  PLATFORM_SETTINGS_RESOURCE_TYPE,
} from '@/types/platform/settings';

import { getPlatformConfigInvalidationPublisher } from '../../services/platformConfigInvalidation';
import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import { adminSettingsRouter } from './settings';

const { policyState } = vi.hoisted(() => ({ policyState: { enabled: false } }));
const serverDB: LobeChatDatabase = await getTestDB();

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => serverDB),
}));

vi.mock('../../featureFlags', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getDefaultEnterpriseFeatureFlags: () => Record<string, boolean>;
  };
  return {
    ...actual,
    getEnterpriseFeatureFlags: () => ({
      ...actual.getDefaultEnterpriseFeatureFlags(),
      ENABLE_PLATFORM_SETTINGS_POLICY: policyState.enabled,
    }),
  };
});

const ids = {
  allowed: 'settings-audit-allowed',
  denied: 'settings-audit-denied',
  updateOnly: 'settings-audit-update-only',
} as const;
const updateOnlyRoleName = 'settings_update_only_role';

const cleanup = async () => {
  // Scope audit cleanup to this suite's actors so concurrent suites are not wiped (SG-07).
  await deletePlatformAuditLogsForTest(serverDB, { actorUserIds: Object.values(ids) });
  await deletePlatformResourceRevisionsForTest(serverDB, {
    resourceIds: [PLATFORM_SETTINGS_RESOURCE_ID],
    resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
  });
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
  const owned = await serverDB
    .select({ id: roles.id })
    .from(roles)
    .where(inArray(roles.name, [updateOnlyRoleName]));
  if (owned.length > 0) {
    const roleIds = owned.map((r) => r.id);
    await serverDB.delete(userRoles).where(inArray(userRoles.roleId, roleIds));
    await serverDB.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await serverDB.delete(roles).where(inArray(roles.id, roleIds));
  }
  await serverDB.delete(userRoles);
  await serverDB.delete(rolePermissions);
  await serverDB.delete(roles);
  await serverDB.delete(permissions);
  await serverDB.delete(users);
};

beforeEach(async () => {
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  policyState.enabled = false;
  await cleanup();
  await serverDB
    .insert(users)
    .values([{ id: ids.allowed }, { id: ids.denied }, { id: ids.updateOnly }]);
  await seedPlatformRoles(serverDB);
  const superAdmin = await serverDB.query.roles.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(table.workspaceId)),
  });
  await serverDB.insert(userRoles).values({
    roleId: superAdmin!.id,
    userId: ids.allowed,
    workspaceId: null,
  });
  const platformUser = await serverDB.query.roles.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.name, PLATFORM_SYSTEM_ROLES.PLATFORM_USER), isNull(table.workspaceId)),
  });
  await serverDB.insert(userRoles).values({
    roleId: platformUser!.id,
    userId: ids.denied,
    workspaceId: null,
  });

  // UPDATE without PUBLISH — applyImmediate secondary check must deny.
  const [updateRole] = await serverDB
    .insert(roles)
    .values({ displayName: updateOnlyRoleName, name: updateOnlyRoleName })
    .returning();
  const updatePerms = await serverDB
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      inArray(permissions.code, [
        PLATFORM_PERMISSIONS.SETTINGS_READ,
        PLATFORM_PERMISSIONS.SETTINGS_UPDATE,
      ]),
    );
  await serverDB
    .insert(rolePermissions)
    .values(updatePerms.map(({ id }) => ({ permissionId: id, roleId: updateRole.id })));
  await serverDB.insert(userRoles).values({
    roleId: updateRole.id,
    userId: ids.updateOnly,
    workspaceId: null,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
  vi.unstubAllEnvs();
});

const caller = async (
  userId: string,
  auth: {
    authenticatedAt?: Date | null;
    authMethod?: 'api-key' | 'better-auth';
  } = { authenticatedAt: new Date(), authMethod: 'better-auth' },
) =>
  adminSettingsRouter.createCaller({
    ...(await createContextInner({
      authenticatedAt: auth.authenticatedAt,
      authMethod: auth.authMethod ?? 'better-auth',
      userId,
    })),
    serverDB,
  } as never);

describe('admin.settings denied audit outcomes', () => {
  it('applyImmediate requires SETTINGS_PUBLISH in addition to SETTINGS_UPDATE', async () => {
    policyState.enabled = true;
    const updateOnly = await caller(ids.updateOnly);
    await expect(
      updateOnly.applyImmediate({
        patch: { 'memory.enabled': true },
        reason: 'must require publish',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await serverDB.select().from(platformSettingPolicies)).toEqual([]);
    // Feature was on and UPDATE passed middleware; denial is the secondary PUBLISH check.
    // No success mutation audit should land.
    const audits = await serverDB.select().from(platformAuditLogs);
    expect(audits).not.toContainEqual(
      expect.objectContaining({
        action: 'admin.settings.applyImmediate',
        result: 'success',
      }),
    );
  });

  it('feature-disabled denial persists a sanitized audit and mutates no settings state', async () => {
    await expect((await caller(ids.allowed)).getDraft()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const [audits, bundles, policies, revisions] = await Promise.all([
      serverDB.select().from(platformAuditLogs),
      serverDB.select().from(platformSettingsBundle),
      serverDB.select().from(platformSettingPolicies),
      serverDB
        .select()
        .from(platformResourceRevisions)
        .where(
          and(
            eq(platformResourceRevisions.resourceType, PLATFORM_SETTINGS_RESOURCE_TYPE),
            eq(platformResourceRevisions.resourceId, PLATFORM_SETTINGS_RESOURCE_ID),
          ),
        ),
    ]);
    expect(audits).toMatchObject([
      {
        action: 'admin.settings.getDraft',
        afterDiff: null,
        beforeDiff: null,
        reason: 'feature_disabled',
        result: 'denied',
      },
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/secret|apiKey|value/i);
    expect(bundles).toEqual([]);
    expect(policies).toEqual([]);
    expect(revisions).toEqual([]);
  });

  it('permission denial is audited before the settings feature guard', async () => {
    await expect((await caller(ids.denied)).getDraft()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const audits = await serverDB.select().from(platformAuditLogs);
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.permission.denied',
        result: 'denied',
      }),
    );
    expect(audits).not.toContainEqual(
      expect.objectContaining({ action: 'admin.settings.getDraft', result: 'success' }),
    );
  });

  it('guards save before state writes or invalidation', async () => {
    policyState.enabled = true;
    const saveInput = {
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 0,
      policies: {},
      reason: 'save guarded settings',
    };
    const invalidation = vi.spyOn(getPlatformConfigInvalidationPublisher(), 'publish');

    for (const auth of [
      { authenticatedAt: null, authMethod: 'better-auth' as const },
      {
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth' as const,
      },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ]) {
      const denied = await caller(ids.allowed, auth);
      await expect(denied.save(saveInput)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    expect(invalidation).not.toHaveBeenCalled();
    await expect(
      serverDB
        .select()
        .from(platformResourceRevisions)
        .where(
          and(
            eq(platformResourceRevisions.resourceType, PLATFORM_SETTINGS_RESOURCE_TYPE),
            eq(platformResourceRevisions.resourceId, PLATFORM_SETTINGS_RESOURCE_ID),
          ),
        ),
    ).resolves.toEqual([]);
    await expect(serverDB.select().from(platformSettingPolicies)).resolves.toEqual([]);
    await expect(serverDB.select().from(platformSettingsBundle)).resolves.toEqual([]);
    const deniedAudits = (await serverDB.select().from(platformAuditLogs)).filter(
      ({ result }) => result === 'denied',
    );
    expect(deniedAudits.filter(({ action }) => action === 'admin.settings.save')).toHaveLength(3);
    expect(deniedAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ afterDiff: { error: 'reauth_required' }, result: 'denied' }),
      ]),
    );

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const insert = vi.spyOn(serverDB, 'insert').mockImplementationOnce(() => {
      throw new Error('save audit unavailable');
    });
    const missingReauth = await caller(ids.allowed, { authenticatedAt: null });
    await expect(missingReauth.save(saveInput)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(invalidation).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /save guarded settings|settings-audit-allowed/,
    );
    insert.mockRestore();
    consoleError.mockRestore();

    // Authorised save publishes site-wide immediately: one revision, one invalidation.
    const fresh = await caller(ids.allowed);
    const draft = await fresh.getDraft();
    const saved = await fresh.save({
      ...saveInput,
      expectedDraftToken: draft.draftToken,
      expectedRevision: draft.baseRevision,
      policies: {
        'general.fontSize': { mode: 'default', schemaVersion: 1, value: 16, visibility: 'visible' },
      },
    });
    expect(saved).toMatchObject({
      auditId: expect.any(String),
      draftToken: expect.any(String),
      revision: 1,
    });
    expect(invalidation).toHaveBeenCalledTimes(1);
    const after = await fresh.getDraft();
    expect(after.baseRevision).toBe(1);
    expect(after.publishedPolicies['general.fontSize']?.value).toBe(16);
    // Draft column is aligned to published — nothing stays pending.
    expect(after.draft).toEqual(after.publishedPolicies);
    expect(after.draftToken).toBe(saved.draftToken);
    expect(await serverDB.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.settings.save', result: 'success' }),
    );

    // A stale CAS base must be refused so the client refreshes instead of clobbering.
    await expect(
      fresh.save({
        ...saveInput,
        expectedDraftToken: draft.draftToken,
        expectedRevision: draft.baseRevision,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(invalidation).toHaveBeenCalledTimes(1);
  });

  it('save with an empty policy map restores defaults for owned paths only', async () => {
    policyState.enabled = true;
    const fresh = await caller(ids.allowed);
    const seed = await fresh.getDraft();
    await fresh.save({
      expectedDraftToken: seed.draftToken,
      expectedRevision: seed.baseRevision,
      policies: {
        'general.fontSize': { mode: 'default', schemaVersion: 1, value: 18, visibility: 'visible' },
      },
      reason: 'seed owned policy',
    });

    const seeded = await fresh.getDraft();
    await fresh.save({
      expectedDraftToken: seeded.draftToken,
      expectedRevision: seeded.baseRevision,
      policies: {},
      reason: 'restore defaults',
    });

    expect(await serverDB.select().from(platformSettingPolicies)).toEqual([]);
    expect((await fresh.getDraft()).baseRevision).toBe(2);
  });

  it('requires SETTINGS_PUBLISH in addition to SETTINGS_UPDATE to save', async () => {
    policyState.enabled = true;
    const updateOnly = await caller(ids.updateOnly);
    await expect(
      updateOnly.save({
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 0,
        policies: {},
        reason: 'must require publish',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await serverDB.select().from(platformSettingPolicies)).toEqual([]);
  });
});

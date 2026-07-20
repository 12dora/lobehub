// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { getPlatformConfigInvalidationPublisher } from '../../services/platformConfigInvalidation';
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

const ids = { allowed: 'settings-audit-allowed', denied: 'settings-audit-denied' } as const;

const cleanup = async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(platformSettingPolicies);
  await serverDB.delete(platformSettingsBundle);
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
  await serverDB.insert(users).values([{ id: ids.allowed }, { id: ids.denied }]);
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
  it('feature-disabled denial persists a sanitized audit and mutates no settings state', async () => {
    await expect((await caller(ids.allowed)).getDraft()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const [audits, bundles, policies, revisions] = await Promise.all([
      serverDB.select().from(platformAuditLogs),
      serverDB.select().from(platformSettingsBundle),
      serverDB.select().from(platformSettingPolicies),
      serverDB.select().from(platformResourceRevisions),
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

  it('guards publish and rollback before state writes or invalidation', async () => {
    policyState.enabled = true;
    const publishInput = {
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 0,
      reason: 'publish guarded settings',
    };
    const rollbackInput = {
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'rollback guarded settings',
      targetRevision: 1,
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
      await expect(denied.publish(publishInput)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(denied.rollback(rollbackInput)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    expect(invalidation).not.toHaveBeenCalled();
    await expect(serverDB.select().from(platformResourceRevisions)).resolves.toEqual([]);
    await expect(serverDB.select().from(platformSettingPolicies)).resolves.toEqual([]);
    await expect(serverDB.select().from(platformSettingsBundle)).resolves.toEqual([]);
    const deniedAudits = (await serverDB.select().from(platformAuditLogs)).filter(
      ({ result }) => result === 'denied',
    );
    expect(deniedAudits.filter(({ action }) => action === 'admin.settings.publish')).toHaveLength(
      3,
    );
    expect(deniedAudits.filter(({ action }) => action === 'admin.settings.rollback')).toHaveLength(
      3,
    );
    expect(deniedAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ afterDiff: { error: 'reauth_required' }, result: 'denied' }),
      ]),
    );

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const insert = vi
      .spyOn(serverDB, 'insert')
      .mockImplementationOnce(() => {
        throw new Error('publish audit unavailable');
      })
      .mockImplementationOnce(() => {
        throw new Error('rollback audit unavailable');
      });
    const missingReauth = await caller(ids.allowed, { authenticatedAt: null });
    await expect(missingReauth.publish(publishInput)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(missingReauth.rollback(rollbackInput)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(invalidation).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /publish guarded settings|rollback guarded settings|settings-audit-allowed/,
    );
    insert.mockRestore();
    consoleError.mockRestore();

    const fresh = await caller(ids.allowed);
    const draft = await fresh.getDraft();
    const published = await fresh.publish({
      ...publishInput,
      expectedDraftToken: draft.draftToken,
      expectedRevision: draft.baseRevision,
    });
    expect(published).toMatchObject({ auditId: expect.any(String), revision: 1 });
    expect(invalidation).toHaveBeenCalledTimes(1);
    const afterPublish = await fresh.getDraft();
    const secondPublished = await fresh.publish({
      ...publishInput,
      expectedDraftToken: afterPublish.draftToken,
      expectedRevision: published.revision,
      reason: 'publish second guarded settings revision',
    });
    const afterSecondPublish = await fresh.getDraft();
    await expect(
      fresh.rollback({
        ...rollbackInput,
        expectedDraftToken: afterSecondPublish.draftToken,
        expectedRevision: secondPublished.revision,
        targetRevision: published.revision,
      }),
    ).resolves.toMatchObject({ auditId: expect.any(String), revision: 3 });
    expect(invalidation).toHaveBeenCalledTimes(3);
  });
});

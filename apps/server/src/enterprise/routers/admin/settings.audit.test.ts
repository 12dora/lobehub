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
  await cleanup();
  vi.unstubAllEnvs();
});

const caller = async (userId: string) =>
  adminSettingsRouter.createCaller({
    ...(await createContextInner({ userId })),
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
});

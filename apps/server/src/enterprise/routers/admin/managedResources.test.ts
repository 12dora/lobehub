// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformManagedResourcePolicies,
  platformResourceRevisions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import type { AuthMethod } from '@/libs/trpc/lambda/context';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { adminRouter } from '../admin';

let db: LobeChatDatabase;
const createCaller = createCallerFactory(adminRouter);

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const ids = {
  aiAdmin: 'm06-router-ai-admin',
  auditor: 'm06-router-auditor',
  normal: 'm06-router-normal',
};

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformManagedResourcePolicies);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

const context = async (
  userId: string,
  auth: { authenticatedAt?: Date | null; authMethod?: AuthMethod | null } = {
    authenticatedAt: new Date(),
    authMethod: 'better-auth',
  },
) => ({
  ...(await createContextInner({ userId, ...auth })),
  serverDB: db,
});

beforeAll(async () => {
  db = await getTestDB();
});

beforeEach(async () => {
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
    userId: ids.aiAdmin,
  });
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AUDITOR,
    userId: ids.auditor,
  });
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    userId: ids.normal,
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('admin.managedResources permission contract', () => {
  it('denies normal users and records a sanitized denied audit', async () => {
    const caller = createCaller((await context(ids.normal)) as never);
    await expect(caller.managedResources.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.permission.denied', result: 'denied' }),
    );
  });

  it('lets auditors read but not save drafts', async () => {
    const caller = createCaller((await context(ids.auditor)) as never);
    const current = await caller.managedResources.get();
    await expect(
      caller.managedResources.saveDraft({
        draft: current.draft,
        expectedDraftToken: current.draftToken,
        reason: 'auditor must not write',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets ai_admin save and publish a ui-only policy with CAS', async () => {
    const caller = createCaller((await context(ids.aiAdmin)) as never);
    const current = await caller.managedResources.get();
    const draft = {
      ...current.draft,
      skills: { enforcementMode: 'ui-only' as const, managed: true },
    };
    await caller.managedResources.saveDraft({
      draft,
      expectedDraftToken: current.draftToken,
      reason: 'prepare skills rollout',
    });
    const saved = await caller.managedResources.get();
    const result = await caller.managedResources.publish({
      expectedDraftToken: saved.draftToken,
      expectedRevision: saved.baseRevision,
      reason: 'publish skills rollout',
    });
    expect(result.revision).toBe(1);
    expect((await caller.managedResources.get()).published.skills).toEqual(draft.skills);
  });

  it.each([
    {
      auth: { authenticatedAt: new Date(Date.now() - 60 * 60 * 1000), authMethod: 'better-auth' },
      label: 'stale',
    },
    {
      auth: { authenticatedAt: null, authMethod: 'better-auth' },
      label: 'missing',
    },
    {
      auth: { authenticatedAt: new Date(), authMethod: 'api-key' },
      label: 'api-key',
    },
  ] as const)('denies $label publish reauth and writes denied audit', async ({ auth, label }) => {
    const caller = createCaller((await context(ids.aiAdmin, auth)) as never);
    const current = await caller.managedResources.get();
    const reason = `denied-${label}`;
    await expect(
      caller.managedResources.publish({
        expectedDraftToken: current.draftToken,
        expectedRevision: current.baseRevision,
        reason,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(await db.select().from(platformResourceRevisions)).toHaveLength(0);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.managedResources.publish',
        actorUserId: ids.aiAdmin,
        afterDiff: { error: 'reauth_required' },
        reason,
        result: 'denied',
        targetId: 'global',
        targetType: 'managed_policy',
      }),
    );
  });
});

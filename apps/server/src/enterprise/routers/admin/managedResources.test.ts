// @vitest-environment node
import { and, eq } from 'drizzle-orm';
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
import {
  MANAGED_POLICY_RESOURCE_ID,
  MANAGED_POLICY_RESOURCE_TYPE,
} from '@/types/platform/managedResources';

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import { adminRouter } from '../admin';

let db: LobeChatDatabase;
const createCaller = createCallerFactory(adminRouter);
const runtimeTransition = vi.hoisted(() => ({
  begin: vi.fn(async () => 'managed-transition-token'),
  cancel: vi.fn(async () => undefined),
  finalize: vi.fn(async () => undefined),
}));

vi.mock('@/server/enterprise/services/connectorCatalog/runtimeEffectiveState', () => ({
  beginConnectorRuntimeEffectiveStateTransition: runtimeTransition.begin,
  cancelConnectorRuntimeEffectiveStateTransition: runtimeTransition.cancel,
  finalizeConnectorRuntimeEffectiveStateTransition: runtimeTransition.finalize,
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const ids = {
  aiAdmin: 'm06-router-ai-admin',
  auditor: 'm06-router-auditor',
  normal: 'm06-router-normal',
};

const cleanup = async () => {
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(ids) });
  await deletePlatformResourceRevisionsForTest(db, {
    resourceIds: [MANAGED_POLICY_RESOURCE_ID],
    resourceType: MANAGED_POLICY_RESOURCE_TYPE,
  });
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

// PGlite applies the full migration baseline on first getTestDB() — allow headroom.
beforeAll(async () => {
  db = await getTestDB();
}, 120_000);

beforeEach(async () => {
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  runtimeTransition.begin.mockClear();
  runtimeTransition.cancel.mockClear();
  runtimeTransition.finalize.mockReset();
  runtimeTransition.finalize.mockResolvedValue(undefined);
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

  it('lets auditors read but not save', async () => {
    const caller = createCaller((await context(ids.auditor)) as never);
    const current = await caller.managedResources.get();
    await expect(
      caller.managedResources.save({
        draft: current.draft,
        expectedDraftToken: current.draftToken,
        expectedRevision: current.baseRevision,
        reason: 'auditor must not write',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('applies a ui-only policy site-wide in one save with CAS', async () => {
    const caller = createCaller((await context(ids.aiAdmin)) as never);
    const current = await caller.managedResources.get();
    const draft = {
      ...current.draft,
      skills: { enforcementMode: 'ui-only' as const, managed: true },
    };
    const result = await caller.managedResources.save({
      draft,
      expectedDraftToken: current.draftToken,
      expectedRevision: current.baseRevision,
      reason: 'roll out skills policy',
    });
    expect(result.revision).toBe(1);
    expect(result.runtimeTransition).toBe('finalized');
    const after = await caller.managedResources.get();
    expect(after.published.skills).toEqual(draft.skills);
    // Draft column is aligned to published: nothing is left pending.
    expect(after.draft).toEqual(after.published);
    expect(after.status).toBe('published');

    // Replaying the now-stale CAS base must be refused, not silently re-applied.
    await expect(
      caller.managedResources.save({
        draft,
        expectedDraftToken: current.draftToken,
        expectedRevision: current.baseRevision,
        reason: 'stale replay',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns the committed revision with pending recovery when connector finalization fails', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
    runtimeTransition.finalize.mockRejectedValueOnce(new Error('shared authority unavailable'));
    const caller = createCaller((await context(ids.aiAdmin)) as never);
    const current = await caller.managedResources.get();
    const draft = {
      ...current.draft,
      connectors: { enforcementMode: 'ui-only' as const, managed: true },
    };

    const result = await caller.managedResources.save({
      draft,
      expectedDraftToken: current.draftToken,
      expectedRevision: current.baseRevision,
      reason: 'roll out connector policy',
    });
    expect(result).toMatchObject({ revision: 1, runtimeTransition: 'pending_recovery' });
    expect((await caller.managedResources.get()).published.connectors).toEqual(draft.connectors);
    expect(runtimeTransition.cancel).not.toHaveBeenCalled();
  });

  it('cancels the connector transition and writes nothing when the readiness gate blocks save', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
    const caller = createCaller((await context(ids.aiAdmin)) as never);
    const current = await caller.managedResources.get();
    // Nothing is seeded in the connector catalog, so `enforced` is not ready.
    expect(current.readiness.connectors).toBe(false);

    await expect(
      caller.managedResources.save({
        draft: {
          ...current.draft,
          connectors: { enforcementMode: 'enforced' as const, managed: true },
        },
        expectedDraftToken: current.draftToken,
        expectedRevision: current.baseRevision,
        reason: 'enforce before the catalog is ready',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(runtimeTransition.cancel).toHaveBeenCalledWith('managed-transition-token');
    expect(runtimeTransition.finalize).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(platformResourceRevisions)
        .where(
          and(
            eq(platformResourceRevisions.resourceType, MANAGED_POLICY_RESOURCE_TYPE),
            eq(platformResourceRevisions.resourceId, MANAGED_POLICY_RESOURCE_ID),
          ),
        ),
    ).toHaveLength(0);
    expect((await caller.managedResources.get()).published.connectors.managed).toBe(false);
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
  ] as const)('denies $label save reauth and writes denied audit', async ({ auth, label }) => {
    const caller = createCaller((await context(ids.aiAdmin, auth)) as never);
    const current = await caller.managedResources.get();
    const reason = `denied-${label}`;
    await expect(
      caller.managedResources.save({
        draft: current.draft,
        expectedDraftToken: current.draftToken,
        expectedRevision: current.baseRevision,
        reason,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(
      await db
        .select()
        .from(platformResourceRevisions)
        .where(
          and(
            eq(platformResourceRevisions.resourceType, MANAGED_POLICY_RESOURCE_TYPE),
            eq(platformResourceRevisions.resourceId, MANAGED_POLICY_RESOURCE_ID),
          ),
        ),
    ).toHaveLength(0);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.managedResources.save',
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

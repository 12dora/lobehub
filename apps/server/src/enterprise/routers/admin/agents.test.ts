// @vitest-environment node
import { inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformJobs,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(adminRouter);
const createCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).agents;
const ids = {
  assigner: 'm10-router-assigner',
  creator: 'm10-router-creator',
  deleter: 'm10-router-deleter',
  normal: 'm10-router-normal',
  publisher: 'm10-router-publisher',
  reader: 'm10-router-reader',
  updater: 'm10-router-updater',
};

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformJobs},
      ${platformAgentAssignments},
      ${platformAgentVersions},
      ${platformAgents},
      ${userRoles},
      ${rolePermissions},
      ${roles},
      ${permissions},
      ${users}
    CASCADE
  `);
};

const grantPermissions = async (userId: string, name: string, codes: string[]) => {
  const [role] = await db
    .insert(roles)
    .values({ displayName: name, name, workspaceId: null })
    .returning();
  const rows = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, codes));
  await db
    .insert(rolePermissions)
    .values(rows.map(({ id }) => ({ permissionId: id, roleId: role.id })));
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

const callerFor = async (params: { authenticatedAt?: Date | null; userId?: string }) =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: params.authenticatedAt,
      authMethod: 'better-auth',
      userId: params.userId,
    })),
    serverDB: db,
  } as never);

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await grantPermissions(ids.reader, 'm10_agent_reader', [PLATFORM_PERMISSIONS.AGENT_READ]);
  await grantPermissions(ids.creator, 'm10_agent_creator', [PLATFORM_PERMISSIONS.AGENT_CREATE]);
  await grantPermissions(ids.updater, 'm10_agent_updater', [PLATFORM_PERMISSIONS.AGENT_UPDATE]);
  await grantPermissions(ids.publisher, 'm10_agent_publisher', [
    PLATFORM_PERMISSIONS.AGENT_PUBLISH,
  ]);
  await grantPermissions(ids.deleter, 'm10_agent_deleter', [PLATFORM_PERMISSIONS.AGENT_DELETE]);
  await grantPermissions(ids.assigner, 'm10_agent_assigner', [PLATFORM_PERMISSIONS.AGENT_ASSIGN]);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('adminAgentsRouter security gates', () => {
  it('enforces anonymous, ordinary and granular permissions per operation', async () => {
    await expect((await callerFor({})).list({ limit: 10 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      (await callerFor({ authenticatedAt: new Date(), userId: ids.normal })).list({ limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const reader = await callerFor({ authenticatedAt: new Date(), userId: ids.reader });
    await expect(reader.list({ limit: 10 })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(reader.rollouts.list({ agentId: 'missing-agent', limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(
      reader.create({ agentKey: 'reader-denied', reason: 'reader cannot create' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const creator = await callerFor({ authenticatedAt: new Date(), userId: ids.creator });
    const created = await creator.create({ agentKey: 'router-agent', reason: 'create Agent' });
    await expect(creator.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const updater = await callerFor({ authenticatedAt: new Date(), userId: ids.updater });
    await expect(
      updater.updateDraft({
        agentId: created.identity.id,
        expectedDraftToken: created.draftToken,
        expectedRevision: created.identity.revision,
        isDefault: false,
        reason: 'update Agent draft',
        systemKey: null,
      }),
    ).resolves.toMatchObject({ identity: { draftSequence: 1 } });
    await expect(updater.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const assigner = await callerFor({ authenticatedAt: new Date(), userId: ids.assigner });
    await expect(
      assigner.assignments.preview({
        agentId: created.identity.id,
        assignment: {
          enabled: true,
          mode: 'optional',
          pinnedVersionId: null,
          targetId: '__global__',
          targetType: 'global',
          versionPolicy: 'latest_published',
        },
      }),
    ).resolves.toMatchObject({ estimatedUsers: Object.values(ids).length });
    await expect(assigner.assignments.list({ agentId: created.identity.id })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(
      assigner.rollouts.list({ agentId: created.identity.id, limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const publisher = await callerFor({ authenticatedAt: new Date(), userId: ids.publisher });
    const detail = await reader.get({ id: created.identity.id });
    await expect(
      publisher.publish({
        agentId: detail.identity.id,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.identity.revision,
        reason: 'publish missing version',
        versionId: 'missing-version',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(publisher.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const deleter = await callerFor({ authenticatedAt: new Date(), userId: ids.deleter });
    await expect(
      deleter.archive({
        agentId: 'missing-agent',
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 0,
        reason: 'archive missing Agent',
        replacementAgentId: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects dangerous operations before mutation when recent reauth is absent', async () => {
    const stalePublisher = await callerFor({ authenticatedAt: null, userId: ids.publisher });
    await expect(
      stalePublisher.publish({
        agentId: 'missing-agent',
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 0,
        reason: 'publish needs reauth',
        versionId: 'missing-version',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      stalePublisher.setDefaultInbox({
        currentDefault: null,
        nextDefault: {
          agentId: 'missing-agent',
          expectedDraftToken: 'a'.repeat(64),
          expectedRevision: 0,
        },
        reason: 'default switch needs reauth',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const staleDeleter = await callerFor({ authenticatedAt: null, userId: ids.deleter });
    await expect(
      staleDeleter.archive({
        agentId: 'missing-agent',
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 0,
        reason: 'archive needs reauth',
        replacementAgentId: null,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const staleAssigner = await callerFor({ authenticatedAt: null, userId: ids.assigner });
    await expect(
      staleAssigner.rollouts.start({
        agentId: 'missing-agent',
        assignmentId: 'missing-assignment',
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 0,
        reason: 'rollout needs reauth',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await db.select().from(platformAuditLogs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'admin.agents.publish', result: 'denied' }),
        expect.objectContaining({ action: 'admin.agents.setDefaultInbox', result: 'denied' }),
        expect.objectContaining({ action: 'admin.agents.archive', result: 'denied' }),
        expect.objectContaining({ action: 'admin.agents.rollouts.start', result: 'denied' }),
      ]),
    );
  });

  it('short-circuits disabled Admin endpoints', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    const reader = await callerFor({ authenticatedAt: new Date(), userId: ids.reader });
    await expect(reader.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reader.rollouts.list({ agentId: 'agent-support', limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

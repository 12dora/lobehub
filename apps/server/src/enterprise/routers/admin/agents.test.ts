// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform/checksum';
import {
  permissions,
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAiProviders,
  platformAuditLogs,
  platformJobs,
  platformResourceRevisions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { platformAgentDraftToken } from '../../services/agentCatalog';
import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const databaseMocks = vi.hoisted(() => ({ getServerDB: vi.fn() }));
const createRootCaller = createCallerFactory(adminRouter);
const createCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).agents;
const ids = {
  assigner: 'm10-router-assigner',
  /** AGENT_CREATE + AGENT_PUBLISH — create publishes, so it needs both. */
  creator: 'm10-router-creator',
  /** AGENT_CREATE only — must be denied by the compound create gate. */
  creatorNoPublish: 'm10-router-creator-nopublish',
  deleter: 'm10-router-deleter',
  /** AGENT_UPDATE + AGENT_PUBLISH — the save gate. */
  editor: 'm10-router-editor',
  normal: 'm10-router-normal',
  publisher: 'm10-router-publisher',
  reader: 'm10-router-reader',
  updater: 'm10-router-updater',
};

const PROVIDER_CHECKSUM = 'c'.repeat(64);

const dependencySnapshot = {
  connectors: [],
  model: {
    modelKey: 'chat',
    providerChecksum: PROVIDER_CHECKSUM,
    providerKey: 'provider',
    providerRevision: 1,
  },
  skills: [],
};

const agentConfig = (displayName: string) => ({
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName,
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Help users.',
  tags: [],
});

/** Minimal published provider + revision so agent dependency revalidation succeeds. */
const seedPublishedProvider = async () => {
  await db.insert(platformAiProviders).values({
    displayName: 'Provider',
    enabled: true,
    id: 'provider-id',
    providerKey: 'provider',
    revision: 1,
    status: 'published',
  });
  await db.insert(platformResourceRevisions).values({
    checksum: PROVIDER_CHECKSUM,
    id: 'provider-revision-1',
    payload: {
      models: [{ enabled: true, modelKey: 'chat', type: 'chat' }],
      provider: { enabled: true, providerKey: 'provider' },
    },
    publishedAt: new Date(),
    resourceId: 'provider-id',
    resourceType: 'provider',
    revision: 1,
    status: 'published',
  });
};

const createAgent = async (
  caller: Awaited<ReturnType<typeof callerFor>>,
  agentKey: string,
  reason: string,
) => caller.create({ agentKey, config: agentConfig(agentKey), dependencySnapshot, reason });

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: databaseMocks.getServerDB,
}));

const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformJobs},
      ${platformAgentAssignments},
      ${platformAgentVersions},
      ${platformAgents},
      ${platformResourceRevisions},
      ${platformAiProviders},
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

const callerFor = async (params: {
  authenticatedAt?: Date | null;
  authMethod?: 'api-key' | 'better-auth';
  userId?: string;
}) =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: params.authenticatedAt,
      authMethod: params.authMethod ?? 'better-auth',
      userId: params.userId,
    })),
    serverDB: db,
  } as never);

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  databaseMocks.getServerDB.mockReset().mockResolvedValue(db);
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await grantPermissions(ids.reader, 'm10_agent_reader', [PLATFORM_PERMISSIONS.AGENT_READ]);
  await grantPermissions(ids.creator, 'm10_agent_creator', [
    PLATFORM_PERMISSIONS.AGENT_CREATE,
    PLATFORM_PERMISSIONS.AGENT_PUBLISH,
  ]);
  await grantPermissions(ids.creatorNoPublish, 'm10_agent_creator_nopublish', [
    PLATFORM_PERMISSIONS.AGENT_CREATE,
  ]);
  await grantPermissions(ids.editor, 'm10_agent_editor', [
    PLATFORM_PERMISSIONS.AGENT_UPDATE,
    PLATFORM_PERMISSIONS.AGENT_PUBLISH,
  ]);
  await grantPermissions(ids.updater, 'm10_agent_updater', [PLATFORM_PERMISSIONS.AGENT_UPDATE]);
  await grantPermissions(ids.publisher, 'm10_agent_publisher', [
    PLATFORM_PERMISSIONS.AGENT_PUBLISH,
  ]);
  await grantPermissions(ids.deleter, 'm10_agent_deleter', [PLATFORM_PERMISSIONS.AGENT_DELETE]);
  await grantPermissions(ids.assigner, 'm10_agent_assigner', [PLATFORM_PERMISSIONS.AGENT_ASSIGN]);
  await seedPublishedProvider();
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
      createAgent(reader, 'reader-denied', 'reader cannot create'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Compound create gate: AGENT_CREATE alone is not enough now that create publishes.
    const creatorNoPublish = await callerFor({
      authenticatedAt: new Date(),
      userId: ids.creatorNoPublish,
    });
    await expect(
      createAgent(creatorNoPublish, 'half-granted', 'create without publish'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const creator = await callerFor({ authenticatedAt: new Date(), userId: ids.creator });
    const created = await createAgent(creator, 'router-agent', 'create Agent');
    // Create publishes live in the same transaction.
    expect(created.identity).toMatchObject({ revision: 1, status: 'published' });
    expect(created.version).toMatchObject({ version: '1.0.0' });
    expect(created.identity.currentVersionId).toBe(created.version.id);
    await expect(creator.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Compound save gate: UPDATE alone and PUBLISH alone are both denied.
    const updater = await callerFor({ authenticatedAt: new Date(), userId: ids.updater });
    const saveInput = {
      agentId: created.identity.id,
      config: agentConfig('router-agent'),
      dependencySnapshot,
      expectedDraftToken: created.draftToken,
      expectedRevision: created.identity.revision,
      reason: 'save Agent',
    };
    await expect(updater.save(saveInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
      publisher.save({ ...saveInput, expectedDraftToken: detail.draftToken }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(publisher.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The editor holds both halves of the compound gate and saves a live new version.
    const editor = await callerFor({ authenticatedAt: new Date(), userId: ids.editor });
    const saved = await editor.save({
      ...saveInput,
      config: agentConfig('router-agent v2'),
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.identity.revision,
    });
    expect(saved.identity).toMatchObject({ revision: 2, status: 'published' });
    // Server-generated label: patch bump of the created 1.0.0.
    expect(saved.version).toMatchObject({ version: '1.0.1' });
    expect(saved.identity.currentVersionId).toBe(saved.version.id);
    // Stale CAS is a conflict, not a silent overwrite.
    await expect(
      editor.save({ ...saveInput, expectedDraftToken: detail.draftToken }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

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
    const staleEditor = await callerFor({ authenticatedAt: null, userId: ids.editor });
    await expect(
      staleEditor.save({
        agentId: 'missing-agent',
        config: agentConfig('needs reauth'),
        dependencySnapshot,
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 0,
        reason: 'save needs reauth',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const stalePublisher = await callerFor({ authenticatedAt: null, userId: ids.publisher });
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
        expect.objectContaining({ action: 'admin.agents.save', result: 'denied' }),
        expect.objectContaining({ action: 'admin.agents.setDefaultInbox', result: 'denied' }),
        expect.objectContaining({ action: 'admin.agents.archive', result: 'denied' }),
        expect.objectContaining({ action: 'admin.agents.rollouts.start', result: 'denied' }),
      ]),
    );
  });

  it('guards assignment create, update and remove before business writes', async () => {
    const creator = await callerFor({ authenticatedAt: new Date(), userId: ids.creator });
    const created = await createAgent(
      creator,
      'reauth-assignment-agent',
      'create assignment test Agent',
    );
    const createInput = {
      agentId: created.identity.id,
      enabled: true,
      expectedDraftToken: created.draftToken,
      expectedRevision: created.identity.revision,
      mode: 'optional' as const,
      pinnedVersionId: null,
      reason: 'create guarded assignment',
      targetId: '__global__',
      targetType: 'global' as const,
      versionPolicy: 'latest_published' as const,
    };
    for (const auth of [
      { authenticatedAt: null, authMethod: 'better-auth' as const },
      {
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth' as const,
      },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ]) {
      const caller = await callerFor({ ...auth, userId: ids.assigner });
      await expect(caller.assignments.upsert(createInput)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
    expect(await db.select().from(platformAgentAssignments)).toEqual([]);
    await expect(
      db
        .select()
        .from(platformAgents)
        .where(sql`${platformAgents.id} = ${created.identity.id}`),
    ).resolves.toMatchObject([
      { draftSequence: created.identity.draftSequence, revision: created.identity.revision },
    ]);
    expect(
      (await db.select().from(platformAuditLogs)).filter(
        ({ action }) => action === 'admin.agents.assignments.upsert',
      ),
    ).toHaveLength(3);

    const insert = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('audit sink unavailable');
    });
    await expect(
      (
        await callerFor({
          authenticatedAt: null,
          authMethod: 'better-auth',
          userId: ids.assigner,
        })
      ).assignments.upsert(createInput),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await db.select().from(platformAgentAssignments)).toEqual([]);
    insert.mockRestore();

    const assigner = await callerFor({ authenticatedAt: new Date(), userId: ids.assigner });
    const created1 = await assigner.assignments.upsert(createInput);
    const assignment = created1.assignment;
    expect(await db.select().from(platformAgentAssignments)).toMatchObject([
      { enabled: true, id: assignment.id },
    ]);
    // The write echoes back the advanced CAS, so the next assignment write chains without a re-GET.
    const afterCreate = await (
      await callerFor({ authenticatedAt: new Date(), userId: ids.reader })
    ).get({ id: created.identity.id });
    expect(created1.draftToken).toBe(afterCreate.draftToken);
    expect(created1.identity.revision).toBe(afterCreate.identity.revision);
    const updated = await assigner.assignments.upsert({
      ...createInput,
      assignmentId: assignment.id,
      enabled: false,
      expectedDraftToken: created1.draftToken,
      expectedRevision: created1.identity.revision,
      reason: 'update guarded assignment',
    });
    expect(updated.assignment).toMatchObject({ enabled: false, id: assignment.id });
    expect(await db.select().from(platformAgentAssignments)).toMatchObject([
      { enabled: false, id: assignment.id },
    ]);

    const removeInput = {
      agentId: created.identity.id,
      assignmentId: assignment.id,
      expectedDraftToken: updated.draftToken,
      expectedRevision: updated.identity.revision,
      reason: 'remove guarded assignment',
    };
    for (const auth of [
      { authenticatedAt: null, authMethod: 'better-auth' as const },
      {
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth' as const,
      },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ]) {
      await expect(
        (
          await callerFor({
            ...auth,
            userId: ids.assigner,
          })
        ).assignments.remove(removeInput),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    expect(await db.select().from(platformAgentAssignments)).toMatchObject([
      { enabled: false, id: assignment.id },
    ]);
    expect(
      (await db.select().from(platformAuditLogs)).filter(
        ({ action }) => action === 'admin.agents.assignments.remove',
      ),
    ).toHaveLength(3);

    const removeInsert = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('audit sink unavailable');
    });
    await expect(
      (
        await callerFor({
          authenticatedAt: null,
          authMethod: 'better-auth',
          userId: ids.assigner,
        })
      ).assignments.remove(removeInput),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await db.select().from(platformAgentAssignments)).toMatchObject([
      { enabled: false, id: assignment.id },
    ]);
    removeInsert.mockRestore();

    await expect(assigner.assignments.remove(removeInput)).resolves.toMatchObject({
      identity: { id: created.identity.id },
      removed: true,
    });
    expect(await db.select().from(platformAgentAssignments)).toEqual([]);
  });

  it('short-circuits disabled Admin endpoints', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    const reader = await callerFor({ authenticatedAt: new Date(), userId: ids.reader });
    await expect(reader.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reader.rollouts.list({ agentId: 'agent-support', limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('gates Rollout before serverDatabase, active-user and RBAC when only Admin is enabled', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    databaseMocks.getServerDB.mockClear();
    const context = await createContextInner({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId: ids.reader,
    });
    const caller = createCaller(context as never);

    await expect(
      caller.rollouts.list({ agentId: 'agent-support', limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(databaseMocks.getServerDB).not.toHaveBeenCalled();
  });

  it('redacts an unknown SQL mutation failure while retaining a classified failure audit', async () => {
    const dependencySnapshot = {
      connectors: [],
      model: {
        modelKey: 'chat',
        providerChecksum: 'a'.repeat(64),
        providerKey: 'provider',
        providerRevision: 1,
      },
      skills: [],
    };
    const config = {
      avatar: null,
      backgroundColor: null,
      description: null,
      displayName: 'Redaction test',
      modelParameters: {},
      openingMessage: null,
      openingQuestions: [],
      systemRole: 'Safe',
      tags: [],
    };
    await db.insert(platformAgents).values({
      agentKey: 'redaction-agent',
      id: 'redaction-agent',
      migrationRequired: false,
      revision: 1,
      title: 'Redaction Agent',
    });
    await db.insert(platformAgentVersions).values({
      agentId: 'redaction-agent',
      checksum: checksumPayload({ config, dependencySnapshot }),
      config,
      dependencySnapshot,
      id: 'redaction-version',
      version: '1.0.0',
    });
    await db
      .update(platformAgents)
      .set({ currentVersionId: 'redaction-version', publishedAt: new Date(), status: 'published' })
      .where(sql`${platformAgents.id} = 'redaction-agent'`);
    await db.insert(platformAgentAssignments).values({
      agentId: 'redaction-agent',
      enabled: true,
      id: 'redaction-assignment',
      mode: 'mandatory',
      pinnedVersionId: null,
      status: 'active',
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });
    const [identity] = await db
      .select()
      .from(platformAgents)
      .where(sql`${platformAgents.id} = 'redaction-agent'`);
    await db.execute(
      sql.raw(`
      CREATE FUNCTION rr2_reject_rollout_job() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'SQL constraint platform_jobs_secret_unique leaked-secret';
      END;
      $$ LANGUAGE plpgsql
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE TRIGGER rr2_reject_rollout_job
      BEFORE INSERT ON platform_jobs
      FOR EACH ROW EXECUTE FUNCTION rr2_reject_rollout_job()
    `),
    );
    try {
      const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.assigner });
      let responseError: unknown;
      try {
        await caller.rollouts.start({
          agentId: identity.id,
          assignmentId: 'redaction-assignment',
          expectedDraftToken: platformAgentDraftToken(identity),
          expectedRevision: identity.revision,
          reason: 'redaction route test',
        });
      } catch (error) {
        responseError = error;
      }
      expect(responseError).toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Platform temporarily unavailable',
      });
      expect(JSON.stringify(responseError)).not.toMatch(
        /platform_jobs_secret_unique|leaked-secret|constraint/i,
      );
      const audits = await db
        .select()
        .from(platformAuditLogs)
        .where(sql`${platformAuditLogs.action} = 'admin.agents.rollouts.start'`);
      expect(audits).toEqual([
        expect.objectContaining({
          afterDiff: { error: 'rollout_mutation_failed' },
          result: 'failure',
        }),
      ]);
      expect(JSON.stringify(audits)).not.toMatch(/platform_jobs_secret_unique|leaked-secret/);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER rr2_reject_rollout_job ON platform_jobs'));
      await db.execute(sql.raw('DROP FUNCTION rr2_reject_rollout_job()'));
    }
  });
});

describe('adminAgentsRouter hard delete', () => {
  const agentRows = (agentId: string) =>
    db.select().from(platformAgents).where(eq(platformAgents.id, agentId));

  it('hard-deletes a published agent and writes a success audit', async () => {
    const creator = await callerFor({ authenticatedAt: new Date(), userId: ids.creator });
    const created = await createAgent(creator, 'delete-me', 'seed for delete');
    const deleter = await callerFor({ authenticatedAt: new Date(), userId: ids.deleter });

    await expect(
      deleter.delete({
        agentId: created.identity.id,
        expectedDraftToken: created.draftToken,
        expectedRevision: created.identity.revision,
        reason: 'remove test agent',
      }),
    ).resolves.toEqual({ deleted: true });

    expect(await agentRows(created.identity.id)).toHaveLength(0);
    const audits = await db.select().from(platformAuditLogs);
    expect(
      audits.some(
        ({ action, result, targetId }) =>
          action === 'admin.agents.delete' &&
          result === 'success' &&
          targetId === created.identity.id,
      ),
    ).toBe(true);
  });

  it('denies a caller without AGENT_DELETE', async () => {
    const normal = await callerFor({ authenticatedAt: new Date(), userId: ids.normal });
    await expect(
      normal.delete({
        agentId: 'any-agent',
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 1,
        reason: 'no permission',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a stale-reauth delete before mutating and records a denied audit', async () => {
    const creator = await callerFor({ authenticatedAt: new Date(), userId: ids.creator });
    const created = await createAgent(creator, 'delete-stale', 'seed for delete');
    const staleDeleter = await callerFor({ authenticatedAt: null, userId: ids.deleter });

    await expect(
      staleDeleter.delete({
        agentId: created.identity.id,
        expectedDraftToken: created.draftToken,
        expectedRevision: created.identity.revision,
        reason: 'stale reauth delete',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(await agentRows(created.identity.id)).toHaveLength(1);
    const audits = await db.select().from(platformAuditLogs);
    expect(
      audits.some(({ action, result }) => action === 'admin.agents.delete' && result === 'denied'),
    ).toBe(true);
  });

  it('refuses to hard-delete the default Inbox agent', async () => {
    await db.insert(platformAgents).values({
      agentKey: 'default-inbox-agent',
      id: 'default-inbox-agent',
      isDefault: true,
      systemKey: 'default-inbox',
      title: 'Default Inbox',
    });
    const deleter = await callerFor({ authenticatedAt: new Date(), userId: ids.deleter });

    await expect(
      deleter.delete({
        agentId: 'default-inbox-agent',
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 1,
        reason: 'try delete default',
      }),
    ).rejects.toThrow();
    expect(await agentRows('default-inbox-agent')).toHaveLength(1);
  });
});

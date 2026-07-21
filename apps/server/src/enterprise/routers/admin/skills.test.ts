// @vitest-environment node
import { WORKSPACE_SYSTEM_ROLES } from '@lobechat/const/rbac';
import { inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
  rolePermissions,
  roles,
  userRoles,
  users,
  workspaces,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { seedWorkspaceRoles } from '@/database/utils/seedWorkspaceRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import type { SkillManifest } from '../../contracts/skillCatalog';
import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { getBuiltinSkillDefinitions } from '../../services/skillCatalog';
import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(adminRouter);
const createCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).skills;
const workspaceId = 'm08-router-workspace';
const ids = {
  aiAdmin: 'm08-router-ai-admin',
  creator: 'm08-router-creator',
  deleter: 'm08-router-deleter',
  normal: 'm08-router-normal',
  publisher: 'm08-router-publisher',
  reader: 'm08-router-reader',
  superAdmin: 'm08-router-super',
  updater: 'm08-router-updater',
  workspaceOwner: 'm08-router-workspace-owner',
};

const manifest = {
  description: 'Router Skill',
  displayName: 'Router Skill',
  localizedDescriptions: {},
  localizedDisplayNames: {},
  permissions: {
    filesystem: 'none',
    network: { allowedHosts: [], enabled: false },
    tools: { allow: [] },
  },
  skillDependencies: [],
  toolDependencies: [],
} satisfies SkillManifest;

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('@lobechat/builtin-skills', () => ({
  builtinSkills: [
    {
      content: '# Mock builtin Skill',
      description: 'Mock builtin Skill',
      identifier: 'mock-builtin',
      name: 'Mock builtin',
      source: 'builtin',
    },
  ],
}));

const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformSkillVersions},
      ${platformSkills},
      ${userRoles},
      ${rolePermissions},
      ${roles},
      ${permissions},
      ${workspaces},
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

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'M08 Router Workspace',
    primaryOwnerId: ids.workspaceOwner,
    slug: workspaceId,
  });
  await seedWorkspaceRoles(db, workspaceId);
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
    userId: ids.superAdmin,
  });
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
    userId: ids.aiAdmin,
  });
  for (const userId of [ids.normal, ids.workspaceOwner]) {
    await assignGlobalPlatformRole(db, {
      roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
      userId,
    });
  }
  const { RbacModel } = await import('@/database/models/rbac');
  await new RbacModel(db, ids.workspaceOwner).assignWorkspaceRole({
    roleName: WORKSPACE_SYSTEM_ROLES.OWNER,
    userId: ids.workspaceOwner,
    workspaceId,
  });
  await grantPermissions(ids.reader, 'm08_skill_reader', [PLATFORM_PERMISSIONS.SKILL_READ]);
  await grantPermissions(ids.creator, 'm08_skill_creator', [PLATFORM_PERMISSIONS.SKILL_CREATE]);
  await grantPermissions(ids.updater, 'm08_skill_updater', [PLATFORM_PERMISSIONS.SKILL_UPDATE]);
  await grantPermissions(ids.publisher, 'm08_skill_publisher', [
    PLATFORM_PERMISSIONS.SKILL_PUBLISH,
  ]);
  await grantPermissions(ids.deleter, 'm08_skill_deleter', [PLATFORM_PERMISSIONS.SKILL_DELETE]);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

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

const createDraft = async (userId = ids.superAdmin) => {
  const caller = await callerFor({ authenticatedAt: new Date(), userId });
  return caller.create({
    allowBuiltinOverride: false,
    displayName: 'Router Skill',
    distribution: 'default',
    enabled: true,
    reason: 'create reviewed router skill',
    skillKey: `router.skill.${Date.now()}`,
  });
};

const createVersion = async (
  draft: Awaited<ReturnType<typeof createDraft>>,
  userId = ids.superAdmin,
) => {
  const caller = await callerFor({ authenticatedAt: new Date(), userId });
  const content = '# router skill';
  return caller.createVersion({
    content,
    contentRef: null,
    expectedDraftToken: draft.draftToken,
    expectedRevision: draft.draft.revision,
    manifest,
    reason: 'create reviewed router version',
    resources: [],
    skillId: draft.draft.id,
    version: '1.0.0',
  });
};

describe('adminSkillsRouter RBAC and contract gates', () => {
  it('denies anonymous, ordinary and workspace-owner principals', async () => {
    const anonymous = await callerFor({});
    await expect(anonymous.list({ limit: 10 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    for (const userId of [ids.normal, ids.workspaceOwner]) {
      const caller = await callerFor({ authenticatedAt: new Date(), userId });
      await expect(caller.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.create({
          displayName: 'Denied',
          reason: 'must be denied',
          skillKey: `denied.${userId}`,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.permission.denied', result: 'denied' }),
    );
  });

  it('enforces granular read/create/update/publish/delete permissions', async () => {
    const reader = await callerFor({ authenticatedAt: new Date(), userId: ids.reader });
    await expect(reader.list({ limit: 10 })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(reader.getDependents({ skillId: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      reader.create({ displayName: 'Denied', reason: 'read only', skillKey: 'reader.denied' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const draft = await createDraft(ids.creator);
    const creator = await callerFor({ authenticatedAt: new Date(), userId: ids.creator });
    await expect(creator.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const updater = await callerFor({ authenticatedAt: new Date(), userId: ids.updater });
    const updated = await updater.updateDraft({
      displayName: 'Updated by narrow role',
      expectedDraftToken: draft.draftToken,
      expectedRevision: draft.draft.revision,
      id: draft.draft.id,
      reason: 'update with narrow permission',
    });
    const version = await createVersion(updated, ids.updater);
    const ready = await createVersionDetail(draft.draft.id);
    await expect(
      updater.validate({
        expectedDraftToken: ready.draftToken,
        expectedRevision: ready.baseRevision,
        reason: 'validate with update permission',
        skillId: draft.draft.id,
        versionId: version.id,
      }),
    ).resolves.toMatchObject({ issues: [] });

    const detail = await createVersionDetail(draft.draft.id);
    const publisher = await callerFor({ authenticatedAt: new Date(), userId: ids.publisher });
    await expect(
      publisher.publish({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: draft.draft.id,
        reason: 'publish with narrow permission',
        versionId: version.id,
      }),
    ).resolves.toMatchObject({ status: 'published' });
    let publishedDetail = await createVersionDetail(draft.draft.id);
    await expect(
      publisher.rollback({
        expectedDraftToken: publishedDetail.draftToken,
        expectedRevision: publishedDetail.baseRevision,
        id: draft.draft.id,
        reason: 'rollback with narrow permission',
        targetVersionId: version.id,
      }),
    ).resolves.toMatchObject({ status: 'published' });
    publishedDetail = await createVersionDetail(draft.draft.id);
    const deleter = await callerFor({ authenticatedAt: new Date(), userId: ids.deleter });
    await expect(
      deleter.archive({
        expectedDraftToken: publishedDetail.draftToken,
        expectedRevision: publishedDetail.baseRevision,
        id: draft.draft.id,
        reason: 'archive with narrow permission',
      }),
    ).resolves.toMatchObject({ status: 'archived' });
  });

  it('rejects a client-supplied checksum before the createVersion service runs', async () => {
    const draft = await createDraft(ids.creator);
    const updater = await callerFor({ authenticatedAt: new Date(), userId: ids.updater });
    const input = {
      checksum: 'b'.repeat(64),
      content: '# client checksum must not be trusted',
      contentRef: null,
      expectedDraftToken: draft.draftToken,
      expectedRevision: draft.draft.revision,
      manifest,
      reason: 'server must compute canonical checksum',
      resources: [],
      skillId: draft.draft.id,
      version: '1.0.0',
    };

    await expect(updater.createVersion(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await db.select().from(platformSkillVersions)).toEqual([]);
  });

  it('allows AI admins and super admins while feature-off fails closed', async () => {
    for (const userId of [ids.aiAdmin, ids.superAdmin]) {
      const caller = await callerFor({ authenticatedAt: new Date(), userId });
      await expect(caller.list({ limit: 10 })).resolves.toMatchObject({ items: [] });
    }
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '0');
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.superAdmin });
    try {
      await caller.list({ limit: 10 });
      expect.fail('expected feature disabled');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe('PLATFORM_FEATURE_DISABLED');
    }
  });
});

const createVersionDetail = async (id: string) => {
  const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.superAdmin });
  return caller.get({ id });
};

describe('adminSkillsRouter reauthentication', () => {
  it('rejects missing, stale and API-key reauth and audits denial', async () => {
    const draft = await createDraft();
    const version = await createVersion(draft);
    const detail = await createVersionDetail(draft.draft.id);
    for (const context of [
      { authenticatedAt: null },
      { authenticatedAt: new Date(Date.now() - 60 * 60 * 1000) },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ]) {
      const caller = await callerFor({ ...context, userId: ids.superAdmin });
      await expect(
        caller.publish({
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          id: draft.draft.id,
          reason: 'reauth denial must be audited',
          versionId: version.id,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    const denied = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.skills.publish' && row.result === 'denied',
    );
    expect(denied).toHaveLength(3);
  });

  it('rejects client-scoped/replayed proof fields and requires reauth for builtin override', async () => {
    const draft = await createDraft();
    const version = await createVersion(draft);
    const detail = await createVersionDetail(draft.draft.id);
    const fresh = await callerFor({ authenticatedAt: new Date(), userId: ids.superAdmin });
    await expect(
      fresh.publish({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: draft.draft.id,
        reason: 'strict input rejects client proof',
        reauthToken: 'client-replay-token',
        versionId: version.id,
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const builtinKey = getBuiltinSkillDefinitions()[0]!.skillKey;
    const stale = await callerFor({ authenticatedAt: null, userId: ids.superAdmin });
    await expect(
      stale.create({
        allowBuiltinOverride: true,
        displayName: 'Reviewed builtin override',
        reason: 'explicit override requires reauth',
        skillKey: builtinKey,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      fresh.create({
        allowBuiltinOverride: true,
        displayName: 'Reviewed builtin override',
        reason: 'explicit override with reauth',
        skillKey: builtinKey,
      }),
    ).resolves.toMatchObject({ draft: { allowBuiltinOverride: true } });
  });

  it('requires reason and recent reauth for rollback and archive', async () => {
    const draft = await createDraft();
    const version = await createVersion(draft);
    let detail = await createVersionDetail(draft.draft.id);
    const fresh = await callerFor({ authenticatedAt: new Date(), userId: ids.superAdmin });
    await fresh.publish({
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'publish before rollback checks',
      versionId: version.id,
    });
    detail = await createVersionDetail(draft.draft.id);
    const stale = await callerFor({ authenticatedAt: null, userId: ids.superAdmin });
    await expect(
      stale.rollback({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: draft.draft.id,
        reason: 'rollback needs reauth',
        targetVersionId: version.id,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      fresh.archive({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: draft.draft.id,
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('admin.skills.applyImmediate', () => {
  it('create without version keeps draft unpublished (soft fail)', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.superAdmin });
    const result = await caller.applyImmediate({
      displayName: 'Draft Only Skill',
      distribution: 'default',
      enabled: true,
      mode: 'create',
      reason: 'create without version',
      skillKey: `draft.only.${Date.now()}`,
    });
    expect(result.published).toBe(false);
    expect(result.revision).toBe(0);
    expect(result.publishError).toMatch(/version/i);
    expect(result.draft.displayName).toBe('Draft Only Skill');
  });

  it('create with version publishes immediately', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.superAdmin });
    const result = await caller.applyImmediate({
      displayName: 'Immediate Skill',
      distribution: 'default',
      enabled: true,
      mode: 'create',
      reason: 'create and publish',
      skillKey: `immediate.skill.${Date.now()}`,
      version: {
        content: '# immediate skill',
        contentRef: null,
        manifest,
        resources: [],
        version: '1.0.0',
      },
    });
    expect(result.published).toBe(true);
    expect(result.revision).toBeGreaterThan(0);
    expect(result.versionId).toBeTruthy();
  });

  it('update republishes an already-published skill', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.superAdmin });
    const created = await caller.applyImmediate({
      displayName: 'Rename Target',
      distribution: 'default',
      enabled: true,
      mode: 'create',
      reason: 'seed',
      skillKey: `rename.target.${Date.now()}`,
      version: {
        content: '# rename target',
        contentRef: null,
        manifest,
        resources: [],
        version: '1.0.0',
      },
    });
    expect(created.published).toBe(true);
    const detail = await caller.get({ id: created.draft.id });
    const updated = await caller.applyImmediate({
      displayName: 'Renamed Immediate',
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.draft.id,
      mode: 'update',
      reason: 'rename immediately',
    });
    expect(updated.published).toBe(true);
    expect(updated.draft.displayName).toBe('Renamed Immediate');
  });

  it('denies callers without publish permission', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.creator });
    await expect(
      caller.applyImmediate({
        displayName: 'Nope',
        mode: 'create',
        reason: 'denied',
        skillKey: `nope.${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies publish-only callers without create permission', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.publisher });
    await expect(
      caller.applyImmediate({
        displayName: 'Nope',
        mode: 'create',
        reason: 'denied create',
        skillKey: `nope.create.${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects stale reauth before mutating', async () => {
    const draft = await createDraft();
    const version = await createVersion(draft);
    const detail = await createVersionDetail(draft.draft.id);
    const fresh = await callerFor({ authenticatedAt: new Date(), userId: ids.superAdmin });
    await fresh.publish({
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'seed publish',
      versionId: version.id,
    });
    const ready = await createVersionDetail(draft.draft.id);
    const stale = await callerFor({
      authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
      userId: ids.superAdmin,
    });
    await expect(
      stale.applyImmediate({
        displayName: 'Blocked',
        expectedDraftToken: ready.draftToken,
        expectedRevision: ready.baseRevision,
        id: draft.draft.id,
        mode: 'update',
        reason: 'stale reauth blocked',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

// @vitest-environment node
import { WORKSPACE_SYSTEM_ROLES } from '@lobechat/const/rbac';
import { inArray, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformConnectors,
  platformConnectorSecrets,
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

import {
  cleanupM09ServiceData,
  ensurePendingM09ServiceSchema,
} from '../../services/connectorCatalog/catalogTestUtils';
import { adminRouter } from '../admin';
import {
  assertAdminConnectorRuntimeDependency,
  createAdminConnectorRuntime,
  executeAdminConnectorOperation,
} from './connectorsSupport';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(adminRouter);
const workspaceId = 'm09-admin-workspace';
const ids = {
  aiAdmin: 'm09-admin-ai-admin',
  auditor: 'm09-admin-auditor',
  creator: 'm09-admin-creator',
  deleter: 'm09-admin-deleter',
  normal: 'm09-admin-normal',
  publisher: 'm09-admin-publisher',
  reader: 'm09-admin-reader',
  tester: 'm09-admin-tester',
  updater: 'm09-admin-updater',
  workspaceOwner: 'm09-admin-workspace-owner',
};

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await cleanupM09ServiceData(db);
  await db.delete(platformAuditLogs);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(workspaces);
  await db.delete(users).where(sql`${users.id} LIKE 'm09-admin-%'`);
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

beforeAll(() => ensurePendingM09ServiceSchema(db));

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('APP_URL', 'https://aihub.example.test');
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
  vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 91).toString('base64'));
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'M09 Admin Workspace',
    primaryOwnerId: ids.workspaceOwner,
    slug: workspaceId,
  });
  await seedWorkspaceRoles(db, workspaceId);
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
    userId: ids.aiAdmin,
  });
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AUDITOR,
    userId: ids.auditor,
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
  await grantPermissions(ids.reader, 'm09_connector_reader', [PLATFORM_PERMISSIONS.CONNECTOR_READ]);
  await grantPermissions(ids.creator, 'm09_connector_creator', [
    PLATFORM_PERMISSIONS.CONNECTOR_CREATE,
  ]);
  await grantPermissions(ids.updater, 'm09_connector_updater', [
    PLATFORM_PERMISSIONS.CONNECTOR_UPDATE,
  ]);
  await grantPermissions(ids.tester, 'm09_connector_tester', [PLATFORM_PERMISSIONS.CONNECTOR_TEST]);
  await grantPermissions(ids.publisher, 'm09_connector_publisher', [
    PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH,
  ]);
  await grantPermissions(ids.deleter, 'm09_connector_deleter', [
    PLATFORM_PERMISSIONS.CONNECTOR_DELETE,
  ]);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (params: {
  authenticatedAt?: Date | null;
  authMethod?: 'api-key' | 'better-auth';
  userId?: string;
}) => {
  const caller = createRootCaller({
    ...(await createContextInner({
      authenticatedAt: params.authenticatedAt,
      authMethod: params.authMethod ?? 'better-auth',
      userId: params.userId,
    })),
    serverDB: db,
  } as never);
  return caller.connectors;
};

const createNoneDraft = async (userId = ids.creator) => {
  const caller = await callerFor({ authenticatedAt: new Date(), userId });
  return caller.createDraft({
    credentialMode: 'none',
    displayName: 'Admin Connector',
    endpoint: 'https://connector.example.test/mcp',
    key: `admin-connector-${Date.now()}`,
    reason: 'create connector draft',
    transport: 'http',
  });
};

describe('admin.connectors RBAC and contract', () => {
  it('denies anonymous, ordinary users, and workspace owners before service access', async () => {
    const anonymous = await callerFor({});
    await expect(anonymous.list({ limit: 10 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    for (const userId of [ids.normal, ids.workspaceOwner]) {
      const caller = await callerFor({ authenticatedAt: new Date(), userId });
      await expect(caller.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.createDraft({
          credentialMode: 'none',
          displayName: 'Denied',
          endpoint: 'https://connector.example.test/mcp',
          key: `denied-${userId}`,
          reason: 'must be denied',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.permission.denied', result: 'denied' }),
    );
  });

  it('allows auditors to read without exposing a write path', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.auditor });
    await expect(caller.list({ limit: 10 })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(caller.get({ id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'PLATFORM_CONNECTOR_NOT_FOUND',
    });
    await expect(
      caller.createDraft({
        credentialMode: 'none',
        displayName: 'Denied',
        endpoint: 'https://connector.example.test/mcp',
        key: 'auditor-denied',
        reason: 'auditor is read only',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('enforces the minimum permission for every operation family', async () => {
    const reader = await callerFor({ authenticatedAt: new Date(), userId: ids.reader });
    await expect(reader.list({ limit: 10 })).resolves.toMatchObject({ items: [] });
    await expect(
      reader.createDraft({
        credentialMode: 'none',
        displayName: 'Denied',
        endpoint: 'https://connector.example.test/mcp',
        key: 'reader-denied',
        reason: 'reader cannot create',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const draft = await createNoneDraft();
    const updater = await callerFor({ authenticatedAt: new Date(), userId: ids.updater });
    const updated = await updater.updateDraft({
      displayName: 'Updated by narrow permission',
      expectedDraftToken: draft.draftToken,
      expectedRevision: draft.draft.revision,
      id: draft.draft.id,
      reason: 'metadata-only update',
    });
    expect(updated.draft.displayName).toBe('Updated by narrow permission');

    const tester = await callerFor({ authenticatedAt: new Date(), userId: ids.tester });
    await expect(
      tester.discover({ id: 'missing', reason: 'prove test permission' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const publisher = await callerFor({ authenticatedAt: new Date(), userId: ids.publisher });
    await expect(
      publisher.publish({
        expectedDraftToken: 'd'.repeat(64),
        expectedRevision: 0,
        id: 'missing',
        reason: 'prove publish permission',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const deleter = await callerFor({ authenticatedAt: new Date(), userId: ids.deleter });
    await expect(
      deleter.deleteDraft({
        expectedDraftToken: 'd'.repeat(64),
        expectedRevision: 0,
        id: 'missing',
        reason: 'prove delete permission',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      deleter.revokeAllBindings({
        expectedRevision: 1,
        id: 'missing',
        reason: 'prove revoke permission',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails closed when the Connector flag or Secret key is unavailable', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.aiAdmin });
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '0');
    await expect(caller.list({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
    vi.stubEnv('PLATFORM_MASTER_KEY', '');
    await expect(caller.list({ limit: 10 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'PLATFORM_SECRET_REQUIRED',
    });
  });

  it('keeps read and none-mode Draft operations independent from OAuth redirect config', async () => {
    const runtime = createAdminConnectorRuntime(db, { appUrlProvider: () => undefined });
    await expect(runtime.service.listDrafts({ limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    const draft = await runtime.service.createDraft(ids.aiAdmin, {
      credentialMode: 'none',
      displayName: 'No redirect dependency',
      endpoint: 'https://connector.example.test/mcp',
      key: 'no-redirect-none-mode',
      reason: 'create none connector without app URL',
      transport: 'http',
    });
    await expect(runtime.service.getDraft(draft.draft.id)).resolves.toMatchObject({
      draft: { credentialMode: 'none' },
    });
    expect(runtime.resolveRedirectUri).toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  });
});

describe('admin.connectors reauthentication and error redaction', () => {
  it('audits authorized mutation factory failures once with stable sanitized categories', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.aiAdmin });
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '0');
    await expect(
      caller.createDraft({
        credentialMode: 'none',
        displayName: 'Feature unavailable',
        endpoint: 'https://connector.example.test/mcp',
        key: 'factory-feature-failure',
        reason: 'operator requested feature-gated create',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PLATFORM_FEATURE_DISABLED' });

    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
    vi.stubEnv('PLATFORM_MASTER_KEY', '');
    const unavailableSecret = 'factory-secret-must-not-enter-audit';
    await expect(
      caller.createDraft({
        credentialMode: 'shared_service_account',
        displayName: 'Secret unavailable',
        endpoint: 'https://connector.example.test/mcp',
        key: 'factory-secret-failure',
        reason: `operator copied ${unavailableSecret}`,
        sharedSecret: { operation: 'replace', value: { apiKey: unavailableSecret } },
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'PLATFORM_SECRET_REQUIRED' });

    vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 91).toString('base64'));
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', 'invalid');
    const tester = await callerFor({ authenticatedAt: new Date(), userId: ids.tester });
    await expect(
      tester.discover({ id: 'transport-failure-target', reason: 'validate outbound transport' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_CONNECTOR_SSRF_BLOCKED',
    });

    const factoryAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) =>
        row.targetType === 'connector' &&
        (row.afterDiff as { error?: string } | null)?.error === 'factory_dependency_unavailable',
    );
    expect(factoryAudits).toHaveLength(3);
    expect(factoryAudits.map((row) => row.afterDiff)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'feature_disabled' }),
        expect.objectContaining({ category: 'secret_unavailable' }),
        expect.objectContaining({ category: 'transport_unavailable' }),
      ]),
    );
    expect(factoryAudits.every((row) => Boolean(row.reason))).toBe(true);
    expect(JSON.stringify(factoryAudits)).not.toContain(unavailableSecret);
  });

  it('audits lazy OAuth redirect dependency failure without entering the service', async () => {
    const runtime = createAdminConnectorRuntime(db, { appUrlProvider: () => undefined });
    await expect(
      assertAdminConnectorRuntimeDependency({
        action: 'admin.connectors.createDraft',
        actorUserId: ids.aiAdmin,
        category: 'redirect_unavailable',
        operation: runtime.resolveRedirectUri,
        reason: 'configure OAuth redirect',
        runtime,
        serverDB: db,
        targetId: 'oauth-redirect-failure',
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    expect(await db.select().from(platformConnectors)).toEqual([]);
    const audits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.connectors.createDraft',
    );
    expect(audits).toEqual([
      expect.objectContaining({
        afterDiff: expect.objectContaining({
          category: 'redirect_unavailable',
          error: 'factory_dependency_unavailable',
        }),
        reason: 'configure OAuth redirect',
        result: 'failure',
        targetId: 'oauth-redirect-failure',
      }),
    ]);
  });

  it('requires reauth for Secret replacement and never persists the denied Secret', async () => {
    const secret = 'opaque-router-replacement-leaf';
    const stale = await callerFor({
      authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
      userId: ids.aiAdmin,
    });
    await expect(
      stale.createDraft({
        credentialMode: 'shared_service_account',
        displayName: 'Denied Shared Connector',
        endpoint: 'https://connector.example.test/mcp',
        key: 'denied-shared',
        reason: `reason copied ${secret}`,
        sharedSecret: { operation: 'replace', value: { apiKey: secret } },
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await db.select().from(platformConnectors)).toEqual([]);
    expect(await db.select().from(platformConnectorSecrets)).toEqual([]);
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'admin.connectors.createDraft', result: 'denied' }),
    );
    expect(JSON.stringify(audits)).not.toContain(secret);
  });

  it('treats explicit replacement and credential-mode switching as reauth-gated clears', async () => {
    const fresh = await callerFor({ authenticatedAt: new Date(), userId: ids.aiAdmin });
    const draft = await fresh.createDraft({
      credentialMode: 'shared_service_account',
      displayName: 'Shared Connector',
      endpoint: 'https://connector.example.test/mcp',
      key: 'shared-update-gates',
      reason: 'create shared connector',
      sharedSecret: { operation: 'replace', value: { apiKey: 'initial-shared-leaf' } },
    });
    const stale = await callerFor({ authenticatedAt: null, userId: ids.aiAdmin });
    await expect(
      stale.updateDraft({
        expectedDraftToken: draft.draftToken,
        expectedRevision: draft.draft.revision,
        id: draft.draft.id,
        reason: 'replace needs reauth',
        sharedSecret: { operation: 'replace', value: { apiKey: 'replacement-leaf' } },
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      stale.updateDraft({
        credentialMode: 'none',
        expectedDraftToken: draft.draftToken,
        expectedRevision: draft.draft.revision,
        id: draft.draft.id,
        reason: 'implicit clear needs reauth',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const detail = await fresh.get({ id: draft.draft.id });
    expect(detail.draft).toMatchObject({
      credentialMode: 'shared_service_account',
      sharedSecret: { configured: true },
    });
    expect(
      (await db.select().from(platformAuditLogs)).filter(
        (row) => row.action === 'admin.connectors.updateDraft' && row.result === 'denied',
      ),
    ).toHaveLength(2);
  });

  it('reauth-gates publish, rollback, archive, and revoke before any mutation', async () => {
    const stale = await callerFor({ authenticatedAt: null, userId: ids.aiAdmin });
    const common = {
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 1,
      id: 'missing-dangerous-target',
      reason: 'dangerous operation requires reauth',
    };
    await expect(stale.publish(common)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(stale.rollback({ ...common, targetRevision: 1 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(stale.archive(common)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      stale.revokeAllBindings({
        expectedRevision: 1,
        id: common.id,
        reason: common.reason,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const deniedActions = (await db.select().from(platformAuditLogs))
      .filter((row) => row.result === 'denied')
      .map((row) => row.action);
    expect(deniedActions).toEqual(
      expect.arrayContaining([
        'admin.connectors.archive',
        'admin.connectors.publish',
        'admin.connectors.revokeAllBindings',
        'admin.connectors.rollback',
      ]),
    );
  });

  it('maps unexpected failures to a fixed code without reflecting raw messages', async () => {
    const privateValue = 'must-never-cross-router-boundary';
    let thrown: unknown;
    try {
      await executeAdminConnectorOperation('admin.connectors.test', async () => {
        throw new Error(privateValue);
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'PLATFORM_CONNECTOR_OPERATION_FAILED',
    });
    expect(JSON.stringify(thrown)).not.toContain(privateValue);
  });
});

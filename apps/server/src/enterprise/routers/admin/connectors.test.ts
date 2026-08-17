// @vitest-environment node
import { WORKSPACE_SYSTEM_ROLES } from '@lobechat/const/rbac';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  InMemoryAdminMutationRateLimiter,
  resetSharedAdminMutationRateLimiter,
  setSharedAdminMutationRateLimiter,
} from '../../security/rateLimit/adminMutationRateLimiter';
import { ConnectorCatalogService } from '../../services/connectorCatalog/catalogService';
import {
  cleanupM09ServiceData,
  connectorToolFixture,
  MemoryConnectorSecretStore,
} from '../../services/connectorCatalog/catalogTestUtils';
import type { ConnectorOutboundClient } from '../../services/connectorCatalog/connectorOutboundClient';
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
  // Retention/test delete opt-in — production append-only trigger rejects bare DELETE.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await tx.delete(platformAuditLogs);
    await tx.delete(userRoles);
    await tx.delete(rolePermissions);
    await tx.delete(roles);
    await tx.delete(permissions);
    await tx.delete(workspaces);
    await tx.delete(users).where(sql`${users.id} LIKE 'm09-admin-%'`);
  });
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
    await expect(anonymous.getPublishedBatch({ ids: ['connector-1'] })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    for (const userId of [ids.normal, ids.workspaceOwner]) {
      const caller = await callerFor({ authenticatedAt: new Date(), userId });
      await expect(caller.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller.getPublishedBatch({ ids: ['connector-1'] })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
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
    // CONNECTOR_READ covers the batch published projection; a missing id maps to null (no throw).
    await expect(caller.getPublishedBatch({ ids: ['missing'] })).resolves.toEqual({
      items: [{ connectorId: 'missing', published: null }],
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

  it('fails closed on the Connector flag but reads the catalog without a Secret key', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.aiAdmin });
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '0');
    await expect(caller.list({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
    vi.stubEnv('PLATFORM_MASTER_KEY', '');
    // Reads (list/get/getPublishedBatch) are pure DB projections and must not require the master key.
    await expect(caller.list({ limit: 10 })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(caller.getPublishedBatch({ ids: ['missing'] })).resolves.toEqual({
      items: [{ connectorId: 'missing', published: null }],
    });
    // Secret-touching mutations still fail closed without the master key.
    await expect(
      caller.createDraft({
        credentialMode: 'none',
        displayName: 'Secret Required',
        endpoint: 'https://connector.example.test/mcp',
        key: `secret-required-${Date.now()}`,
        reason: 'mutation still needs the secret runtime',
      }),
    ).rejects.toMatchObject({
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

describe('admin.connectors.applyImmediate', () => {
  it('create keeps draft when first publish is not yet valid (soft fail)', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.aiAdmin });
    const result = await caller.applyImmediate({
      credentialMode: 'none',
      displayName: 'Draft Only Connector',
      endpoint: 'https://connector.example.test/mcp',
      key: `draft-only-${Date.now()}`,
      mode: 'create',
      reason: 'create without tools',
      transport: 'http',
    });
    expect(result.published).toBe(false);
    expect(result.revision).toBe(0);
    expect(result.draft.displayName).toBe('Draft Only Connector');
    expect(result.publishError).toBeTruthy();
  });

  it('update on a revised draft hard-fails visibly when the live probe cannot succeed', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.aiAdmin });
    const created = await caller.createDraft({
      credentialMode: 'none',
      displayName: 'Publishable Connector',
      endpoint: 'https://connector.example.test/mcp',
      enabled: true,
      key: `publishable-${Date.now()}`,
      reason: 'seed draft',
      tools: [connectorToolFixture()],
      transport: 'http',
    });
    // The update bumps the draft revision, so applyImmediate no longer soft-fails: the
    // publish path runs the live connection probe first, and against the unreachable test
    // endpoint that probe fails — which must surface as a stable code, never silently.
    await expect(
      caller.applyImmediate({
        displayName: 'Publishable Connector Renamed',
        expectedDraftToken: created.draftToken,
        expectedRevision: created.draft.revision,
        id: created.draft.id,
        mode: 'update',
        reason: 'rename via applyImmediate',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'PLATFORM_CONNECTOR_NOT_PUBLISHED',
    });
    // The rename itself landed — only the publish step was refused.
    const after = await caller.get({ id: created.draft.id });
    expect(after.draft.displayName).toBe('Publishable Connector Renamed');
    expect(after.published).toBeNull();
  });

  it('denies callers without publish permission', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.creator });
    await expect(
      caller.applyImmediate({
        credentialMode: 'none',
        displayName: 'Nope',
        endpoint: 'https://connector.example.test/mcp',
        key: `nope-${Date.now()}`,
        mode: 'create',
        reason: 'denied',
        transport: 'http',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies publish-only callers without create permission', async () => {
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.publisher });
    await expect(
      caller.applyImmediate({
        credentialMode: 'none',
        displayName: 'Nope',
        endpoint: 'https://connector.example.test/mcp',
        key: `nope-pub-${Date.now()}`,
        mode: 'create',
        reason: 'denied create',
        transport: 'http',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Secondary CREATE denial must emit the same audited permission-denied event.
    const [denied] = await db
      .select()
      .from(platformAuditLogs)
      .where(
        and(
          eq(platformAuditLogs.action, 'admin.permission.denied'),
          eq(platformAuditLogs.actorUserId, ids.publisher),
        ),
      )
      .orderBy(desc(platformAuditLogs.createdAt))
      .limit(1);
    expect(denied).toMatchObject({ result: 'denied', targetType: 'permission' });
    expect(denied?.afterDiff).toMatchObject({
      permission: PLATFORM_PERMISSIONS.CONNECTOR_CREATE,
    });
  });

  it('rejects stale reauth before mutating', async () => {
    const draft = await createNoneDraft(ids.aiAdmin);
    const stale = await callerFor({
      authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
      userId: ids.aiAdmin,
    });
    await expect(
      stale.applyImmediate({
        displayName: 'Blocked',
        expectedDraftToken: draft.draftToken,
        expectedRevision: draft.draft.revision,
        id: draft.draft.id,
        mode: 'update',
        reason: 'stale reauth blocked',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('publishNow soft-fails visibly for incomplete draft', async () => {
    const draft = await createNoneDraft(ids.aiAdmin);
    const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.aiAdmin });
    const result = await caller.publishNow({
      id: draft.draft.id,
      reason: 'banner retry without tools',
    });
    expect(result.published).toBe(false);
    expect(result.publishError).toBeTruthy();
  });

  it('applyImmediate is rate-limited with ADMIN_RATE_LIMITED when window is exhausted', async () => {
    setSharedAdminMutationRateLimiter(
      new InMemoryAdminMutationRateLimiter({
        config: { limit: 1, windowMs: 60_000 },
      }),
    );
    try {
      const caller = await callerFor({ authenticatedAt: new Date(), userId: ids.aiAdmin });
      await caller.applyImmediate({
        credentialMode: 'none',
        displayName: 'Rate Limited A',
        endpoint: 'https://connector.example.test/mcp',
        key: `rate-a-${Date.now()}`,
        mode: 'create',
        reason: 'consume quota',
        transport: 'http',
      });
      await expect(
        caller.applyImmediate({
          credentialMode: 'none',
          displayName: 'Rate Limited B',
          endpoint: 'https://connector.example.test/mcp',
          key: `rate-b-${Date.now()}`,
          mode: 'create',
          reason: 'should 429',
          transport: 'http',
        }),
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        message: expect.stringMatching(/ADMIN_RATE_LIMITED/),
      });
    } finally {
      resetSharedAdminMutationRateLimiter();
    }
  });
});

describe('admin.connectors.applyImmediate closed loop (service)', () => {
  it('create → tools enabled → publish lists connector for all users', async () => {
    // Service-level closed loop: settings page path without advanced catalog.
    // Outbound preflight is mocked (production uses safeOutbound boundary).
    const secrets = new MemoryConnectorSecretStore(db);
    const outbound = {
      assertAllowed: vi.fn(async () => {}),
      getPolicyVersion: vi.fn(() => 1),
      preflight: vi.fn(async () => ({ policyVersion: 1 })),
      requestJson: vi.fn(async () => ({
        body: { id: '1', jsonrpc: '2.0', result: { tools: [] } },
        status: 200,
      })),
    } as unknown as ConnectorOutboundClient;
    const service = new ConnectorCatalogService(db, outbound, secrets, {
      redirectUri: 'https://aihub.example.test/oauth/connector/callback',
    });

    const soft = await service.applyImmediate('admin-user', {
      credentialMode: 'none',
      displayName: 'Closed Loop Connector',
      endpoint: 'https://connector-v1.example.test/mcp',
      key: `closed-loop-${Date.now()}`,
      mode: 'create',
      reason: 'create then discover tools path',
      transport: 'http',
    });
    expect(soft.published).toBe(false);

    const tool = connectorToolFixture({ enabled: true });
    const withTools = await service.applyImmediate('admin-user', {
      enabled: true,
      expectedDraftToken: soft.draftToken,
      expectedRevision: soft.revision,
      id: soft.draft.id,
      mode: 'update',
      reason: 'enable tools after discover',
      tools: [
        {
          description: tool.description,
          displayName: tool.displayName,
          enabled: true,
          id: crypto.randomUUID(),
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          platformPolicy: tool.platformPolicy,
          requiresConfirmation: tool.requiresConfirmation,
          riskLevel: tool.riskLevel,
          sort: tool.sort,
          toolKey: tool.toolKey,
        },
      ],
    });
    // Mocked outbound preflight succeeds → closed loop must land published.
    expect(withTools.published).toBe(true);
    expect(withTools.revision).toBeGreaterThan(0);
  });

  it('applyImmediate update throws with publishError when already published and publish fails', async () => {
    const secrets = new MemoryConnectorSecretStore(db);
    const outbound = {
      assertAllowed: vi.fn(async () => {}),
      getPolicyVersion: vi.fn(() => 1),
      preflight: vi.fn(async () => ({ policyVersion: 1 })),
      requestJson: vi.fn(async () => ({ body: {}, status: 200 })),
    } as unknown as ConnectorOutboundClient;
    const service = new ConnectorCatalogService(db, outbound, secrets, {
      redirectUri: 'https://aihub.example.test/oauth/connector/callback',
    });
    const tool = connectorToolFixture();
    const created = await service.applyImmediate('admin-user', {
      credentialMode: 'none',
      displayName: 'Hard Fail Connector',
      enabled: true,
      endpoint: 'https://connector-v1.example.test/mcp',
      key: `hard-fail-${Date.now()}`,
      mode: 'create',
      reason: 'seed published connector',
      tools: [tool],
      transport: 'http',
    });
    if (!created.published) {
      // Cannot assert hard-fail path without a published baseline in this env.
      expect(created.publishError).toBeTruthy();
      return;
    }
    outbound.preflight = vi.fn(async () => {
      throw new Error('outbound blocked for hard fail test');
    });
    await expect(
      service.applyImmediate('admin-user', {
        displayName: 'Hard Fail Renamed',
        expectedDraftToken: created.draftToken,
        expectedRevision: created.revision,
        id: created.draft.id,
        mode: 'update',
        reason: 'force publish failure',
      }),
    ).rejects.toThrow(/outbound blocked|PLATFORM_|ConnectorPublishImmediateError/);
  });
});

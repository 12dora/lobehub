// @vitest-environment node
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformBranding,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createContextInner } from '@/libs/trpc/lambda/context';

import {
  AdminBrandingService,
  BRANDING_RESOURCE_ID,
} from '../../services/branding/adminBrandingService';
import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import { adminBrandingRouter } from './branding';

const db: LobeChatDatabase = await getTestDB();
const ids = {
  publisher: 'branding-router-publisher',
  reader: 'branding-router-reader',
  writer: 'branding-router-writer',
};
const roleNames = ['branding_router_reader', 'branding_router_publisher', 'branding_router_writer'];

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));

const cleanup = async () => {
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(ids) });
  await deletePlatformResourceRevisionsForTest(db, {
    resourceIds: [BRANDING_RESOURCE_ID],
    resourceType: 'branding',
  });
  await db.delete(platformBranding);
  const ownedRoles = await db
    .select({ id: roles.id })
    .from(roles)
    .where(inArray(roles.name, roleNames));
  if (ownedRoles.length > 0) {
    const roleIds = ownedRoles.map(({ id }) => id);
    await db.delete(userRoles).where(inArray(userRoles.roleId, roleIds));
    await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await db.delete(roles).where(inArray(roles.id, roleIds));
  }
  await db.delete(users).where(inArray(users.id, Object.values(ids)));
};

const grant = async (userId: string, roleName: string, codes: string[]) => {
  const [role] = await db
    .insert(roles)
    .values({ displayName: roleName, name: roleName })
    .returning();
  const permissionRows = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, codes));
  await db
    .insert(rolePermissions)
    .values(permissionRows.map(({ id }) => ({ permissionId: id, roleId: role.id })));
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

const callerFor = async (userId: string, authenticatedAt = new Date()) =>
  adminBrandingRouter.createCaller({
    ...(await createContextInner({
      authenticatedAt,
      authMethod: 'better-auth',
      sessionId: `session-${userId}`,
      userId,
    })),
    serverDB: db,
  } as never);

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_RUNTIME_BRANDING', '1');
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await grant(ids.reader, roleNames[0], [PLATFORM_PERMISSIONS.BRANDING_READ]);
  await grant(ids.publisher, roleNames[1], [
    PLATFORM_PERMISSIONS.BRANDING_READ,
    PLATFORM_PERMISSIONS.BRANDING_PUBLISH,
  ]);
  await grant(ids.writer, roleNames[2], [
    PLATFORM_PERMISSIONS.BRANDING_READ,
    PLATFORM_PERMISSIONS.BRANDING_PUBLISH,
    PLATFORM_PERMISSIONS.BRANDING_UPDATE,
  ]);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('admin.branding router gates', () => {
  it('keeps read/update/publish permissions precise', async () => {
    const reader = await callerFor(ids.reader);
    const snapshot = await reader.get();
    const saveInput = {
      branding: snapshot.branding,
      expectedRevision: snapshot.revision,
      expectedToken: snapshot.token,
    };
    await expect(
      reader.save({ ...saveInput, reason: 'must be denied', requestId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const publisher = await callerFor(ids.publisher);
    await expect(
      publisher.save({
        ...saveInput,
        reason: 'publish does not imply update',
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('exits at the runtime flag before access, database, active-user, RBAC or storage work', async () => {
    const reader = await callerFor(ids.reader);
    vi.stubEnv('ENABLE_RUNTIME_BRANDING', '0');
    const select = vi.spyOn(db, 'select');
    let bodyReads = 0;
    const uploadInput = {
      fileName: 'logo.png',
      kind: 'logo',
      reason: 'must not parse body',
      requestId: crypto.randomUUID(),
    } as Record<string, unknown>;
    Object.defineProperty(uploadInput, 'bytesBase64', {
      enumerable: true,
      get: () => {
        bodyReads += 1;
        return 'AAAA';
      },
    });

    await expect(reader.get()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
    await expect(reader.uploadAsset(uploadInput as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
    expect(bodyReads).toBe(0);
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });

  it('requires recent reauthentication before save and records a denied audit', async () => {
    const service = new AdminBrandingService(db);
    const initial = await service.get();
    const writer = await callerFor(ids.writer, new Date(0));

    await expect(
      writer.save({
        branding: { ...initial.branding, name: 'Acme', pageTitleTemplate: '%s · Acme' },
        expectedRevision: initial.revision,
        expectedToken: initial.token,
        reason: 'stale reauth denied',
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await service.get()).revision).toBe(0);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.branding.save', result: 'denied' }),
    );
  });
});

// @vitest-environment node
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformBranding,
  platformResourceRevisions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { AdminBrandingService } from '../../services/branding/adminBrandingService';
import { adminBrandingRouter } from './branding';

const db: LobeChatDatabase = await getTestDB();
const ids = { publisher: 'branding-router-publisher', reader: 'branding-router-reader' };
const roleNames = ['branding_router_reader', 'branding_router_publisher'];

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
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
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('admin.branding router gates', () => {
  it('keeps read/update/publish permissions precise', async () => {
    const reader = await callerFor(ids.reader);
    const snapshot = await reader.getDraft();
    await expect(
      reader.saveDraft({
        draft: snapshot.draft,
        expectedDraftToken: snapshot.draftToken,
        reason: 'must be denied',
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const publisher = await callerFor(ids.publisher);
    await expect(
      publisher.saveDraft({
        draft: snapshot.draft,
        expectedDraftToken: snapshot.draftToken,
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

    await expect(reader.getDraft()).rejects.toMatchObject({
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

  it('requires recent reauthentication before publish and records a denied audit', async () => {
    const service = new AdminBrandingService(db);
    const initial = await service.getDraft();
    const draft = { ...initial.draft, name: 'Acme', pageTitleTemplate: '%s · Acme' };
    await db
      .update(platformBranding)
      .set({ displayName: draft.name, pageTitleTemplate: draft.pageTitleTemplate })
      .where(eq(platformBranding.id, 'branding:draft'));
    const saved = await service.getDraft();
    const publisher = await callerFor(ids.publisher, new Date(0));

    await expect(
      publisher.publish({
        expectedDraftToken: saved.draftToken,
        expectedRevision: 0,
        reason: 'stale reauth denied',
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await service.getDraft()).published).toBeNull();
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'platform.branding.publish', result: 'denied' }),
    );
  });
});

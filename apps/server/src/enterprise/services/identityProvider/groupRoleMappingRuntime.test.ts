// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { RbacModel } from '@/database/models/rbac';
import { permissions, rolePermissions, roles, userRoles, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import * as seedPlatformRoles from '@/database/utils/seedPlatformRoles';

import { applyGroupRoleMappingToUser, extractIdentityProviderGroups } from './groupRoleMapping';
import {
  reconcileIdentityProviderGroupRoles,
  resetIdentityProviderGroupRoleMappingRuntimeForTest,
  stashIdentityProviderGroupRoleMapping,
} from './groupRoleMappingRuntime';

const db: LobeChatDatabase = await getTestDB();
const userId = 'user_group_role_e2e';

const cleanup = async () => {
  resetIdentityProviderGroupRoleMappingRuntimeForTest();
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values({ id: userId });
  await seedPlatformRoles.ensurePlatformPermissionsExist(db);
  await seedPlatformRoles.seedPlatformRoles(db);
});
afterEach(cleanup);

describe('identity provider groupRoleMapping runtime enforcement', () => {
  it('end-to-end: IdP group stashed at profile map is enforced as platform role on login reconcile', async () => {
    const groupRoleMapping = {
      engineering: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
    };
    const profileClaims = {
      email: 'eng-user@example.test',
      groups: ['engineering', 'contractors'],
      name: 'Eng User',
      sub: 'idp-subject-eng-1',
    };

    // Mirrors platformIdentityProvider.mapPlatformProfileToUser stash path.
    stashIdentityProviderGroupRoleMapping({
      groupRoleMapping,
      groups: extractIdentityProviderGroups(profileClaims),
      providerKey: 'corp-oidc',
      subject: 'idp-subject-eng-1',
    });

    // Mirrors define-config account/session databaseHooks reconcile call.
    await reconcileIdentityProviderGroupRoles({
      db,
      providerKey: 'corp-oidc',
      subject: 'idp-subject-eng-1',
      userId,
    });

    const rbac = new RbacModel(db, userId);
    const granted = await rbac.getGlobalUserRoles(userId);
    const names = granted.map((role) => role.name).sort();
    expect(names).toEqual(
      [PLATFORM_SYSTEM_ROLES.AI_ADMIN, PLATFORM_SYSTEM_ROLES.PLATFORM_USER].sort(),
    );

    // Stash is one-shot: second reconcile must not re-apply from empty pending.
    await reconcileIdentityProviderGroupRoles({
      db,
      providerKey: 'corp-oidc',
      subject: 'idp-subject-eng-1',
      userId,
    });
    const still = (await rbac.getGlobalUserRoles(userId)).map((r) => r.name).sort();
    expect(still).toEqual(names);
  });

  it('applyGroupRoleMappingToUser grants mapped roles directly (authorization primitive)', async () => {
    const result = await applyGroupRoleMappingToUser({
      db,
      groupRoleMapping: { ops: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN },
      groups: ['ops'],
      userId,
    });
    expect(result.skipped).toBe(false);
    expect(result.applied).toEqual(
      expect.arrayContaining([
        PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
        PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
      ]),
    );

    const rbac = new RbacModel(db, userId);
    const names = (await rbac.getGlobalUserRoles(userId)).map((r) => r.name);
    expect(names).toContain(PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN);
    expect(names).toContain(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
  });
});

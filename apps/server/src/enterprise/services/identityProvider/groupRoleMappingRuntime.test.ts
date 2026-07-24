// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('fail-closed: demotion failure does not leave elevated roles (propagates)', async () => {
    // Seed elevated role first (simulates previous login with admin group).
    await applyGroupRoleMappingToUser({
      db,
      groupRoleMapping: { admins: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN },
      groups: ['admins'],
      userId,
    });
    const rbac = new RbacModel(db, userId);
    expect((await rbac.getGlobalUserRoles(userId)).map((r) => r.name)).toContain(
      PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
    );

    // Force seed map incomplete by requesting a mapped role name that is not seeded as
    // a global role id — actually KNOWN_PLATFORM_ROLES filters unknown. Spy replace to fail.
    const original = rbac.replaceGlobalUserRoles.bind(rbac);
    // Break replace via closing the DB connection path: throw from replace on next apply.
    const { applyGroupRoleMappingToUser: apply } = await import('./groupRoleMapping');
    // Use a broken db handle so replaceGlobalUserRoles fails.
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select' || prop === 'insert' || prop === 'delete' || prop === 'update') {
          return () => {
            throw new Error('simulated role replace outage');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as LobeChatDatabase;

    await expect(
      apply({
        db: brokenDb,
        groupRoleMapping: { admins: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN },
        groups: [], // demotion to platform_user only
        userId,
      }),
    ).rejects.toBeTruthy();

    // Privileged role still present in DB (replace never committed) — caller must not
    // issue a session when reconcile throws.
    expect((await rbac.getGlobalUserRoles(userId)).map((r) => r.name)).toContain(
      PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
    );
    void original;
  });

  it('sweeps expired pending group-role mappings that were never consumed', async () => {
    const {
      discardIdentityProviderGroupRoleMapping,
      pendingIdentityProviderGroupRoleMappingSizeForTest,
      stashIdentityProviderGroupRoleMapping,
    } = await import('./groupRoleMappingRuntime');

    stashIdentityProviderGroupRoleMapping({
      groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['eng'],
      providerKey: 'corp',
      subject: 'stale-subject-1',
    });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBeGreaterThan(0);

    // Expire by rewriting via discard + re-stash with past expiry is internal;
    // discard removes on terminal failure.
    discardIdentityProviderGroupRoleMapping({ providerKey: 'corp', subject: 'stale-subject-1' });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(0);

    // TTL sweep: stash then advance time past TTL.
    vi.useFakeTimers();
    stashIdentityProviderGroupRoleMapping({
      groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['eng'],
      providerKey: 'corp',
      subject: 'stale-subject-2',
    });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(1);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(0);
    vi.useRealTimers();
  });

  it('provider-wide discard is reserved for unload/disable, not per-login failure', async () => {
    // identity/F9: clear-all stays available for provider-wide events only.
    const {
      discardIdentityProviderGroupRoleMappingsForProvider,
      pendingIdentityProviderGroupRoleMappingSizeForTest,
      stashIdentityProviderGroupRoleMapping,
      takeIdentityProviderGroupRoleMapping,
    } = await import('./groupRoleMappingRuntime');

    stashIdentityProviderGroupRoleMapping({
      groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['eng'],
      providerKey: 'corp-oidc',
      subject: 'subject-a',
    });
    stashIdentityProviderGroupRoleMapping({
      groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['eng'],
      providerKey: 'corp-oidc',
      subject: 'subject-b',
    });
    stashIdentityProviderGroupRoleMapping({
      groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['eng'],
      providerKey: 'other-idp',
      subject: 'subject-c',
    });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(3);

    discardIdentityProviderGroupRoleMappingsForProvider('corp-oidc');
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(1);
    expect(
      takeIdentityProviderGroupRoleMapping({ providerKey: 'corp-oidc', subject: 'subject-a' }),
    ).toBeNull();
    expect(
      takeIdentityProviderGroupRoleMapping({ providerKey: 'other-idp', subject: 'subject-c' }),
    ).not.toBeNull();
  });

  it('flow-scoped discard removes only the failed login attempt (identity/F9)', async () => {
    const {
      discardIdentityProviderGroupRoleMappingByFlow,
      pendingIdentityProviderGroupRoleMappingSizeForTest,
      stashIdentityProviderGroupRoleMapping,
      takeIdentityProviderGroupRoleMapping,
    } = await import('./groupRoleMappingRuntime');

    stashIdentityProviderGroupRoleMapping({
      flowId: 'oauth-state-failed',
      groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['eng'],
      providerKey: 'corp-oidc',
      subject: 'subject-failed',
    });
    stashIdentityProviderGroupRoleMapping({
      flowId: 'oauth-state-ok',
      groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['eng'],
      providerKey: 'corp-oidc',
      subject: 'subject-ok',
    });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(2);

    discardIdentityProviderGroupRoleMappingByFlow({
      flowId: 'oauth-state-failed',
      providerKey: 'corp-oidc',
    });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(1);
    expect(
      takeIdentityProviderGroupRoleMapping({
        providerKey: 'corp-oidc',
        subject: 'subject-failed',
      }),
    ).toBeNull();
    expect(
      takeIdentityProviderGroupRoleMapping({
        providerKey: 'corp-oidc',
        subject: 'subject-ok',
      }),
    ).not.toBeNull();
  });

  it('same-provider+same-subject concurrent flows: failed older does not steal surviving reconcile (identity/F9)', async () => {
    const {
      discardIdentityProviderGroupRoleMappingByFlow,
      pendingIdentityProviderGroupRoleMappingSizeForTest,
      reconcileIdentityProviderGroupRoles,
      stashIdentityProviderGroupRoleMapping,
    } = await import('./groupRoleMappingRuntime');

    const subject = 'same-subject-concurrent';
    // Older flow stashes first, then newer flow for the same provider+subject.
    stashIdentityProviderGroupRoleMapping({
      flowId: 'oauth-state-older-fail',
      groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['eng'],
      providerKey: 'corp-oidc',
      subject,
    });
    stashIdentityProviderGroupRoleMapping({
      flowId: 'oauth-state-newer-ok',
      groupRoleMapping: { eng: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['eng'],
      providerKey: 'corp-oidc',
      subject,
    });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(2);

    // Older callback fails: must discard ONLY its flow entry.
    discardIdentityProviderGroupRoleMappingByFlow({
      flowId: 'oauth-state-older-fail',
      providerKey: 'corp-oidc',
    });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(1);

    // Surviving login performs real reconcile with ITS flow id (session.create path).
    await reconcileIdentityProviderGroupRoles({
      db,
      flowId: 'oauth-state-newer-ok',
      providerKey: 'corp-oidc',
      subject,
      userId,
    });

    const rbac = new RbacModel(db, userId);
    const names = (await rbac.getGlobalUserRoles(userId)).map((role) => role.name);
    expect(names).toContain(PLATFORM_SYSTEM_ROLES.AI_ADMIN);
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(0);
  });

  it('success reconciles before concurrent fail cleanup: consumes only its own flow mapping (identity/F9)', async () => {
    // Opposite concurrent ordering: successful session.create.before runs BEFORE
    // the failed callback's after-hook discard. Flow-exact take must never pick the
    // failed flow's mapping (even when that entry is newer by stashedAt).
    const {
      discardIdentityProviderGroupRoleMappingByFlow,
      pendingIdentityProviderGroupRoleMappingSizeForTest,
      reconcileIdentityProviderGroupRoles,
      stashIdentityProviderGroupRoleMapping,
      takeIdentityProviderGroupRoleMapping,
    } = await import('./groupRoleMappingRuntime');

    const subject = 'same-subject-opposite-order';
    // Success flow stashes first with distinguishable groups.
    stashIdentityProviderGroupRoleMapping({
      flowId: 'oauth-state-success',
      groupRoleMapping: { success_group: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
      groups: ['success_group'],
      providerKey: 'corp-oidc',
      subject,
    });
    // Failed concurrent flow stashes later (would win "newest" subject take).
    stashIdentityProviderGroupRoleMapping({
      flowId: 'oauth-state-failed-newer',
      groupRoleMapping: { failed_group: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN },
      groups: ['failed_group'],
      providerKey: 'corp-oidc',
      subject,
    });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(2);

    // SUCCESS path first: session.create.before with this login's OAuth state.
    await reconcileIdentityProviderGroupRoles({
      db,
      flowId: 'oauth-state-success',
      providerKey: 'corp-oidc',
      subject,
      userId,
    });

    const rbac = new RbacModel(db, userId);
    const names = (await rbac.getGlobalUserRoles(userId)).map((role) => role.name);
    // Must apply success_group → AI_ADMIN, never failed_group → IDENTITY_ADMIN.
    expect(names).toContain(PLATFORM_SYSTEM_ROLES.AI_ADMIN);
    expect(names).not.toContain(PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN);

    // Failed callback cleanup still only removes its own entry.
    discardIdentityProviderGroupRoleMappingByFlow({
      flowId: 'oauth-state-failed-newer',
      providerKey: 'corp-oidc',
    });
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'oauth-state-failed-newer',
        providerKey: 'corp-oidc',
        subject,
      }),
    ).toBeNull();
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(0);
  });
});

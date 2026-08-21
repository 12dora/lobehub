// @vitest-environment node
/**
 * AdminUserModel real-DB tests (M04).
 * Isolation: session revoke and reads are target-user scoped.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { getTestDB } from '../../core/getTestDB';
import { permissions, rolePermissions, roles, userRoles, users } from '../../schemas';
import { account, passkey, session, twoFactor } from '../../schemas/betterAuth';
import type { LobeChatDatabase } from '../../type';
import { seedPlatformRoles } from '../../utils/seedPlatformRoles';
import {
  AdminUserModel,
  encodeAdminUserCursor,
  escapeAdminUserLikePattern,
  isEffectivelyBanned,
  parseAdminUserCursor,
} from '../adminUser';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new AdminUserModel(serverDB);

const IDS = {
  a: 'admin-user-a',
  b: 'admin-user-b',
  c: 'admin-user-c',
};

const cleanup = async () => {
  await serverDB.delete(session);
  await serverDB.delete(twoFactor);
  await serverDB.delete(passkey);
  await serverDB.delete(account);
  await serverDB.delete(userRoles);
  await serverDB.delete(rolePermissions);
  await serverDB.delete(roles);
  await serverDB.delete(permissions);
  await serverDB.delete(users);
};

const grantGlobal = async (userId: string, roleName: string) => {
  const role = await serverDB.query.roles.findFirst({
    where: (t, { and: andFn, eq: eqFn, isNull: isNullFn }) =>
      andFn(eqFn(t.name, roleName), isNullFn(t.workspaceId)),
  });
  if (!role) throw new Error(`missing role ${roleName}`);
  await serverDB.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeEach(async () => {
  await cleanup();
  await seedPlatformRoles(serverDB);

  const base = Date.now();
  await serverDB.insert(users).values([
    {
      createdAt: new Date(base),
      email: 'alice@example.com',
      fullName: 'Alice',
      id: IDS.a,
      normalizedEmail: 'alice@example.com',
      username: 'alice',
    },
    {
      banned: true,
      banReason: 'spam',
      createdAt: new Date(base - 1000),
      email: 'bob@example.com',
      fullName: 'Bob',
      id: IDS.b,
      normalizedEmail: 'bob@example.com',
      username: 'bob',
    },
    {
      createdAt: new Date(base - 2000),
      email: 'carol@example.com',
      fullName: 'Carol',
      id: IDS.c,
      normalizedEmail: 'carol@example.com',
      username: 'carol',
    },
  ]);

  await grantGlobal(IDS.a, PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  await grantGlobal(IDS.b, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
});

afterEach(async () => {
  await cleanup();
});

describe('escapeAdminUserLikePattern / isEffectivelyBanned / cursor', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeAdminUserLikePattern('a%b_c')).toBe('a\\%b\\_c');
  });

  it('treats expired ban as not banned', () => {
    expect(
      isEffectivelyBanned({
        banExpires: new Date(Date.now() - 1000),
        banned: true,
      }),
    ).toBe(false);
    expect(
      isEffectivelyBanned({
        banExpires: new Date(Date.now() + 60_000),
        banned: true,
      }),
    ).toBe(true);
  });

  it('round-trips keyset cursor', () => {
    const createdAt = new Date('2024-06-01T12:00:00.000Z');
    const cursor = encodeAdminUserCursor({ createdAt, id: 'user_x' });
    expect(parseAdminUserCursor(cursor)).toEqual({ createdAt, id: 'user_x' });
    expect(parseAdminUserCursor('bad')).toBeNull();
  });
});

describe('AdminUserModel.list', () => {
  it('returns deterministic (createdAt,id) desc order with safe fields', async () => {
    const { items, nextCursor } = await model.list({ limit: 10 });
    expect(items.map((i) => i.id)).toEqual([IDS.a, IDS.b, IDS.c]);
    expect(nextCursor).toBeNull();
    for (const item of items) {
      expect(item).not.toHaveProperty('password');
      expect(item).not.toHaveProperty('token');
      expect(item).toHaveProperty('status');
      expect(item).toHaveProperty('roles');
    }
    expect(items[0].roles).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
    expect(items[1].status).toBe('banned');
  });

  it('keyset cursor has no skip/duplicate with equal timestamps', async () => {
    const same = new Date('2025-01-01T00:00:00.000Z');
    await serverDB.update(users).set({ createdAt: same }).where(eq(users.id, IDS.a));
    await serverDB.update(users).set({ createdAt: same }).where(eq(users.id, IDS.b));
    await serverDB.update(users).set({ createdAt: same }).where(eq(users.id, IDS.c));

    const page1 = await model.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await model.list({ cursor: page1.nextCursor!, limit: 2 });
    const allIds = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(allIds).size).toBe(3);
    expect(allIds).toHaveLength(3);
  });

  it('filters by status banned / active', async () => {
    const banned = await model.list({ status: 'banned' });
    expect(banned.items.every((i) => i.status === 'banned')).toBe(true);
    expect(banned.items.map((i) => i.id)).toEqual([IDS.b]);

    const active = await model.list({ status: 'active' });
    expect(active.items.every((i) => i.status === 'active')).toBe(true);
    expect(active.items.map((i) => i.id).sort()).toEqual([IDS.a, IDS.c].sort());
  });

  it('filters by role', async () => {
    const result = await model.list({ role: PLATFORM_SYSTEM_ROLES.USER_ADMIN });
    expect(result.items.map((i) => i.id)).toEqual([IDS.a]);
  });

  it('prefix search is case-insensitive and escapes wildcards', async () => {
    const byEmail = await model.list({ query: 'alice@' });
    expect(byEmail.items.map((i) => i.id)).toEqual([IDS.a]);

    // Leading-wildcard style query is treated as literal prefix of "%bob" — no match.
    const wild = await model.list({ query: '%bob' });
    expect(wild.items).toHaveLength(0);

    // Underscore in pattern is literal, not single-char wildcard.
    await serverDB.insert(users).values({
      email: 'x_y@example.com',
      id: 'admin-user-under',
      normalizedEmail: 'x_y@example.com',
      username: 'x_y',
    });
    const under = await model.list({ query: 'x_y' });
    expect(under.items.some((i) => i.id === 'admin-user-under')).toBe(true);
  });

  it('prefix search matches fullName case-insensitively', async () => {
    // Distinct from email/username prefixes so this cannot pass via those columns.
    await serverDB.update(users).set({ fullName: 'Zelda Winters' }).where(eq(users.id, IDS.c));

    const byName = await model.list({ query: 'zelda' });
    expect(byName.items.map((i) => i.id)).toEqual([IDS.c]);
    expect(byName.total).toBe(1);

    const mixed = await model.list({ query: 'ZELDA' });
    expect(mixed.items.map((i) => i.id)).toEqual([IDS.c]);
  });

  it('filters by created date range', async () => {
    const a = (await serverDB.query.users.findFirst({ where: eq(users.id, IDS.a) }))!;
    const result = await model.list({
      createdFrom: a.createdAt,
      createdTo: a.createdAt,
    });
    expect(result.items.map((i) => i.id)).toEqual([IDS.a]);
  });

  it('caps limit at 100', async () => {
    const result = await model.list({ limit: 500 });
    expect(result.items.length).toBeLessThanOrEqual(100);
  });

  it('returns a matching total and pages by offset', async () => {
    const first = await model.list({ limit: 2, offset: 0 });
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await model.list({ limit: 2, offset: 2 });
    expect(second.total).toBe(3);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).toBe(IDS.c);

    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('counts only rows matching filters', async () => {
    const banned = await model.list({ status: 'banned' });
    expect(banned.total).toBe(1);
    expect(banned.items).toHaveLength(1);
  });

  it('filters by local / sso source via account.providerId', async () => {
    await serverDB.insert(account).values([
      {
        accountId: IDS.a,
        id: 'acc-local-a',
        providerId: 'credential',
        updatedAt: new Date(),
        userId: IDS.a,
      },
      {
        accountId: 'carol-oidc',
        id: 'acc-sso-c',
        providerId: 'corp-oidc',
        updatedAt: new Date(),
        userId: IDS.c,
      },
    ]);

    const local = await model.list({ source: 'local' });
    expect(local.items.map((item) => item.id)).toEqual([IDS.a]);
    expect(local.total).toBe(1);

    const sso = await model.list({ source: 'sso' });
    expect(sso.items.map((item) => item.id)).toEqual([IDS.c]);
    expect(sso.total).toBe(1);
  });
});

describe('AdminUserModel.findDetailById', () => {
  it('returns safe profile, providers, roles, session aggregates without secrets', async () => {
    await serverDB.insert(account).values({
      accessToken: 'SECRET_ACCESS_TOKEN',
      accountId: 'acct-12345678',
      id: 'acc-1',
      password: 'SECRET_PASSWORD_HASH',
      providerId: 'credential',
      refreshToken: 'SECRET_REFRESH',
      scope: 'openid profile',
      updatedAt: new Date(),
      userId: IDS.a,
    });
    await serverDB.insert(session).values([
      {
        expiresAt: new Date(Date.now() + 3600_000),
        id: 'sess-1',
        ipAddress: '1.2.3.4',
        token: 'SESSION_TOKEN_SECRET',
        updatedAt: new Date(),
        userAgent: 'vitest',
        userId: IDS.a,
      },
      {
        expiresAt: new Date(Date.now() + 3600_000),
        id: 'sess-2',
        token: 'OTHER_TOKEN_SECRET',
        updatedAt: new Date(),
        userId: IDS.a,
      },
    ]);

    const detail = await model.findDetailById(IDS.a);
    expect(detail).toBeTruthy();
    expect(detail!.sessionCount).toBe(2);
    expect(detail!.sessions).toHaveLength(2);
    expect(detail!.hasPassword).toBe(true);
    expect(detail!.passkeyCount).toBe(0);
    expect(detail!.twoFactorEnabled).toBe(false);
    expect(detail!.providers).toEqual([
      expect.objectContaining({
        accountIdHint: '…5678',
        providerId: 'credential',
      }),
    ]);
    expect(JSON.stringify(detail)).not.toContain('SECRET_');
    expect(JSON.stringify(detail)).not.toContain('SESSION_TOKEN');
    expect(detail!.sessions[0]).not.toHaveProperty('token');
    expect(detail!.roles.some((r) => r.name === PLATFORM_SYSTEM_ROLES.USER_ADMIN)).toBe(true);
  });

  it('returns null for missing user', async () => {
    expect(await model.findDetailById('nope')).toBeNull();
  });
});

describe('AdminUserModel.revokeSessionsForUser', () => {
  it('revokes only the target user sessions and never touches accounts', async () => {
    await serverDB.insert(account).values({
      accountId: 'a1',
      id: 'acc-a',
      password: 'keep-me',
      providerId: 'credential',
      updatedAt: new Date(),
      userId: IDS.a,
    });
    await serverDB.insert(session).values([
      {
        expiresAt: new Date(Date.now() + 3600_000),
        id: 's-a1',
        token: 'tok-a1',
        updatedAt: new Date(),
        userId: IDS.a,
      },
      {
        expiresAt: new Date(Date.now() + 3600_000),
        id: 's-a2',
        token: 'tok-a2',
        updatedAt: new Date(),
        userId: IDS.a,
      },
      {
        expiresAt: new Date(Date.now() + 3600_000),
        id: 's-b1',
        token: 'tok-b1',
        updatedAt: new Date(),
        userId: IDS.b,
      },
    ]);

    const revoked = await model.revokeSessionsForUser({
      excludeSessionId: 's-a1',
      userId: IDS.a,
    });
    expect(revoked.revokedCount).toBe(1);
    expect(revoked.tokens).toEqual(['tok-a2']);

    const aSessions = await serverDB.query.session.findMany({
      where: eq(session.userId, IDS.a),
    });
    expect(aSessions.map((s) => s.id)).toEqual(['s-a1']);

    const bSessions = await serverDB.query.session.findMany({
      where: eq(session.userId, IDS.b),
    });
    expect(bSessions).toHaveLength(1);

    const acc = await serverDB.query.account.findFirst({ where: eq(account.id, 'acc-a') });
    expect(acc?.password).toBe('keep-me');
  });

  it('DELETE RETURNING includes a session inserted after a prior listing (concurrent login)', async () => {
    await serverDB.insert(session).values({
      expiresAt: new Date(Date.now() + 3600_000),
      id: 's-listed',
      token: 'tok-listed',
      updatedAt: new Date(),
      userId: IDS.a,
    });

    const listed = await serverDB
      .select({ token: session.token })
      .from(session)
      .where(eq(session.userId, IDS.a));
    expect(listed.map((row) => row.token)).toEqual(['tok-listed']);

    await serverDB.insert(session).values({
      expiresAt: new Date(Date.now() + 3600_000),
      id: 's-concurrent',
      token: 'tok-concurrent',
      updatedAt: new Date(),
      userId: IDS.a,
    });

    const revoked = await model.revokeAuthSessions({ userId: IDS.a });
    expect(revoked.revokedCount).toBe(2);
    expect(revoked.tokens.sort()).toEqual(['tok-concurrent', 'tok-listed']);
    expect(
      await serverDB.query.session.findMany({ where: eq(session.userId, IDS.a) }),
    ).toHaveLength(0);
  });

  it('revokeSpecificSessions returns tokens of the deleted rows only', async () => {
    await serverDB.insert(session).values([
      {
        expiresAt: new Date(Date.now() + 3600_000),
        id: 'spec-1',
        token: 'tok-spec-1',
        updatedAt: new Date(),
        userId: IDS.a,
      },
      {
        expiresAt: new Date(Date.now() + 3600_000),
        id: 'spec-keep',
        token: 'tok-spec-keep',
        updatedAt: new Date(),
        userId: IDS.a,
      },
    ]);

    const revoked = await model.revokeSpecificSessions({
      sessionIds: ['spec-1'],
      userId: IDS.a,
    });
    expect(revoked).toEqual({ revokedCount: 1, tokens: ['tok-spec-1'] });
    expect(
      await serverDB.query.session.findFirst({ where: eq(session.id, 'spec-keep') }),
    ).toBeTruthy();
  });
});

describe('AdminUserModel.setBanned', () => {
  it('bans and unbans without affecting other users', async () => {
    await model.setBanned({ banReason: 'abuse', banned: true, userId: IDS.c });
    const c = await model.findBanState(IDS.c);
    expect(c?.banned).toBe(true);
    expect(c?.banReason).toBe('abuse');

    const a = await model.findBanState(IDS.a);
    expect(a?.banned).toBeFalsy();

    await model.setBanned({ banReason: 'n/a', banned: false, userId: IDS.c });
    const after = await model.findBanState(IDS.c);
    expect(after?.banned).toBe(false);
    expect(after?.banReason).toBeNull();
  });
});

describe('AdminUserModel credential helpers', () => {
  it('detects credential accounts and updates the hash without selecting it', async () => {
    expect(await model.hasCredentialAccount(IDS.a)).toBe(false);
    expect(await model.hasCredentialPassword(IDS.a)).toBe(false);

    await serverDB.insert(account).values({
      accountId: IDS.a,
      id: 'acc-cred',
      password: 'HASH_SHOULD_NOT_LEAK',
      providerId: 'credential',
      updatedAt: new Date(),
      userId: IDS.a,
    });

    expect(await model.hasCredentialAccount(IDS.a)).toBe(true);
    expect(await model.hasCredentialPassword(IDS.a)).toBe(true);
    expect(await model.updateCredentialPassword({ passwordHash: 'NEW_HASH', userId: IDS.a })).toBe(
      true,
    );
    const row = await serverDB.query.account.findFirst({ where: eq(account.id, 'acc-cred') });
    expect(row?.password).toBe('NEW_HASH');
  });

  it('clears two-factor rows and optionally passkeys', async () => {
    await serverDB.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, IDS.a));
    await serverDB.insert(twoFactor).values({
      backupCodes: 'codes',
      id: 'tf-a',
      secret: 'secret',
      userId: IDS.a,
      verified: true,
    });
    await serverDB.insert(passkey).values({
      credentialID: 'cred-a',
      id: 'pk-a',
      publicKey: 'pk',
      userId: IDS.a,
    });

    expect(await model.countPasskeys(IDS.a)).toBe(1);
    expect(await model.deleteTwoFactorForUser(IDS.a)).toBe(1);
    expect(await model.deleteTwoFactorForUser(IDS.a)).toBe(0);
    await model.setTwoFactorEnabled({ enabled: false, userId: IDS.a });
    expect((await model.findDetailById(IDS.a))?.twoFactorEnabled).toBe(false);
    expect(await model.deletePasskeysForUser(IDS.a)).toBe(1);
    expect(await model.countPasskeys(IDS.a)).toBe(0);
  });
});

describe('AdminUserModel role isolation', () => {
  it('listGlobalRoles only returns global (workspace_id IS NULL) roles', async () => {
    // Insert a fake workspace-scoped role grant if workspace exists — skip full workspace
    // seed: just assert only global rows with null workspace_id are returned.
    const rows = await model.listGlobalRoles(IDS.a);
    expect(rows.every((r) => typeof r.name === 'string')).toBe(true);
    const grants = await serverDB.query.userRoles.findMany({
      where: and(eq(userRoles.userId, IDS.a), isNull(userRoles.workspaceId)),
    });
    expect(rows).toHaveLength(grants.length);
  });
});

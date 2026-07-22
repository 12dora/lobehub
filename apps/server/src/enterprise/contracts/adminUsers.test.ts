/**
 * Contract tests for admin.users Zod schemas (M04).
 * Ensures procedures share one validated surface.
 */
import { describe, expect, it } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import {
  ADMIN_USERS_LIST_DEFAULT_LIMIT,
  ADMIN_USERS_LIST_MAX_LIMIT,
  adminUsersBanInputSchema,
  adminUsersCreateInputSchema,
  adminUsersCreateOutputSchema,
  adminUsersGetAuditTrailInputSchema,
  adminUsersGetInputSchema,
  adminUsersGetOutputSchema,
  adminUsersListInputSchema,
  adminUsersListOutputSchema,
  adminUsersReplaceGlobalRolesInputSchema,
  adminUsersRevokeSessionsInputSchema,
  adminUsersUnbanInputSchema,
  escapeLikePattern,
  normalizeAdminUserQuery,
} from './adminUsers';

describe('normalizeAdminUserQuery', () => {
  it('trims, collapses whitespace, lowercases', () => {
    expect(normalizeAdminUserQuery('  Foo   BAR  ')).toBe('foo bar');
  });

  it('returns undefined for empty / whitespace', () => {
    expect(normalizeAdminUserQuery('')).toBeUndefined();
    expect(normalizeAdminUserQuery('   ')).toBeUndefined();
    expect(normalizeAdminUserQuery(null)).toBeUndefined();
    expect(normalizeAdminUserQuery(undefined)).toBeUndefined();
  });
});

describe('escapeLikePattern', () => {
  it('escapes %, _, and backslash for prefix-safe LIKE', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('does not add wildcards itself', () => {
    expect(escapeLikePattern('alice')).toBe('alice');
  });
});

describe('adminUsersListInputSchema', () => {
  it('defaults limit to 50 and normalizes query', () => {
    const parsed = adminUsersListInputSchema.parse({ query: '  Alice  ' });
    expect(parsed.limit).toBe(ADMIN_USERS_LIST_DEFAULT_LIMIT);
    expect(parsed.query).toBe('alice');
  });

  it('rejects limit above max', () => {
    expect(() =>
      adminUsersListInputSchema.parse({ limit: ADMIN_USERS_LIST_MAX_LIMIT + 1 }),
    ).toThrow();
  });

  it('accepts status, role, date range, cursor', () => {
    const from = new Date('2024-01-01T00:00:00.000Z');
    const to = new Date('2024-12-31T00:00:00.000Z');
    const parsed = adminUsersListInputSchema.parse({
      createdFrom: from.toISOString(),
      createdTo: to.toISOString(),
      cursor: '2024-06-01T00:00:00.000Z|user_abc',
      limit: 10,
      role: PLATFORM_SYSTEM_ROLES.USER_ADMIN,
      status: 'banned',
    });
    expect(parsed.status).toBe('banned');
    expect(parsed.createdFrom).toEqual(from);
    expect(parsed.limit).toBe(10);
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => adminUsersListInputSchema.parse({ offset: 10 } as never)).toThrow();
  });
});

describe('adminUsersListOutputSchema', () => {
  it('requires safe list item fields and nextCursor', () => {
    const ok = adminUsersListOutputSchema.parse({
      items: [
        {
          avatar: null,
          createdAt: new Date(),
          email: 'a@b.com',
          fullName: 'A',
          id: 'u1',
          lastActiveAt: null,
          providerIds: ['credential', 'google'],
          roles: ['user_admin'],
          status: 'active',
          username: 'a',
        },
      ],
      nextCursor: null,
    });
    expect(ok.items).toHaveLength(1);
    expect(ok.items[0]!.providerIds).toEqual(['credential', 'google']);
  });

  it('strict list output rejects secret-like fields (password/token/accountId)', () => {
    expect(() =>
      adminUsersListOutputSchema.parse({
        items: [
          {
            avatar: null,
            createdAt: new Date(),
            email: null,
            fullName: null,
            id: 'u1',
            lastActiveAt: null,
            password: 'secret',
            providerIds: [],
            roles: [],
            status: 'active',
            token: 'tok',
            username: null,
          } as never,
        ],
        nextCursor: null,
      }),
    ).toThrow(/password|token|Unrecognized/);

    expect(() =>
      adminUsersListOutputSchema.parse({
        items: [
          {
            accountId: 'acct-1',
            avatar: null,
            createdAt: new Date(),
            email: null,
            fullName: null,
            id: 'u1',
            lastActiveAt: null,
            providerIds: ['google'],
            roles: [],
            status: 'active',
            username: null,
          } as never,
        ],
        nextCursor: null,
      }),
    ).toThrow(/accountId|Unrecognized/);
  });
});

describe('adminUsersGetInputSchema', () => {
  it('requires userId', () => {
    expect(() => adminUsersGetInputSchema.parse({})).toThrow();
    expect(adminUsersGetInputSchema.parse({ userId: 'u1' }).userId).toBe('u1');
  });
});

describe('adminUsersGetOutputSchema isSelf', () => {
  const base = {
    avatar: null,
    banExpires: null,
    banReason: null,
    banned: false,
    createdAt: new Date(),
    email: null,
    fullName: null,
    id: 'u1',
    lastActiveAt: null,
    providers: [],
    roles: [],
    sessionCount: 0,
    sessions: [],
    status: 'active' as const,
    username: null,
  };

  it('accepts isSelf true/false and rejects unexpected fields', () => {
    expect(adminUsersGetOutputSchema.parse({ ...base, isSelf: true }).isSelf).toBe(true);
    expect(adminUsersGetOutputSchema.parse({ ...base, isSelf: false }).isSelf).toBe(false);
    expect(() => adminUsersGetOutputSchema.parse({ ...base } as never)).toThrow();
    expect(() =>
      adminUsersGetOutputSchema.parse({ ...base, isSelf: true, password: 'x' } as never),
    ).toThrow();
  });
});

describe('adminUsersBanInputSchema', () => {
  it('requires reason and rejects past expiresAt', () => {
    expect(() => adminUsersBanInputSchema.parse({ userId: 'u1', reason: '' })).toThrow();
    expect(() =>
      adminUsersBanInputSchema.parse({
        expiresAt: new Date(Date.now() - 60_000),
        reason: 'abuse',
        userId: 'u1',
      }),
    ).toThrow();
  });

  it('accepts future expiresAt', () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const parsed = adminUsersBanInputSchema.parse({
      expiresAt,
      reason: 'temp ban',
      userId: 'u1',
    });
    expect(parsed.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });
});

describe('adminUsersUnbanInputSchema', () => {
  it('requires reason', () => {
    expect(() => adminUsersUnbanInputSchema.parse({ userId: 'u1' })).toThrow();
    expect(adminUsersUnbanInputSchema.parse({ reason: 'ok', userId: 'u1' }).reason).toBe('ok');
  });
});

describe('adminUsersCreateInputSchema', () => {
  const base = {
    email: 'user@example.com',
    fullName: 'User',
    password: 'longenough',
    reason: 'provision',
  };

  it('trims and lowercases email', () => {
    const parsed = adminUsersCreateInputSchema.parse({
      ...base,
      email: '  New.User@Example.COM ',
    });
    expect(parsed.email).toBe('new.user@example.com');
  });

  it('enforces password bounds (8–64) mirroring Better Auth config', () => {
    expect(() => adminUsersCreateInputSchema.parse({ ...base, password: 'a'.repeat(7) })).toThrow();
    expect(adminUsersCreateInputSchema.parse({ ...base, password: 'a'.repeat(8) }).password).toBe(
      'a'.repeat(8),
    );
    expect(adminUsersCreateInputSchema.parse({ ...base, password: 'a'.repeat(64) }).password).toBe(
      'a'.repeat(64),
    );
    expect(() =>
      adminUsersCreateInputSchema.parse({ ...base, password: 'a'.repeat(65) }),
    ).toThrow();
  });

  it('validates optional username charset', () => {
    expect(adminUsersCreateInputSchema.parse(base).username).toBeUndefined();
    expect(adminUsersCreateInputSchema.parse({ ...base, username: 'ok.user-1' }).username).toBe(
      'ok.user-1',
    );
    expect(() => adminUsersCreateInputSchema.parse({ ...base, username: 'bad name!' })).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() =>
      adminUsersCreateInputSchema.parse({ ...base, passwordHash: 'x' } as never),
    ).toThrow();
  });
});

describe('adminUsersCreateOutputSchema', () => {
  it('accepts the safe shape and never carries a password', () => {
    const ok = adminUsersCreateOutputSchema.parse({
      created: true,
      email: 'user@example.com',
      userId: 'user_abc',
    });
    expect(ok.created).toBe(true);
    expect(() =>
      adminUsersCreateOutputSchema.parse({
        created: true,
        email: 'user@example.com',
        password: 'leak',
        userId: 'user_abc',
      } as never),
    ).toThrow();
  });
});

describe('adminUsersRevokeSessionsInputSchema', () => {
  it('defaults includeCurrent optional', () => {
    const parsed = adminUsersRevokeSessionsInputSchema.parse({
      reason: 'compromise',
      userId: 'u1',
    });
    expect(parsed.includeCurrent).toBeUndefined();
  });
});

describe('adminUsersReplaceGlobalRolesInputSchema', () => {
  it('only allows fixed system role packages', () => {
    expect(() =>
      adminUsersReplaceGlobalRolesInputSchema.parse({
        reason: 'r',
        roleNames: ['custom_role'],
        userId: 'u1',
      }),
    ).toThrow();

    const parsed = adminUsersReplaceGlobalRolesInputSchema.parse({
      reason: 'grant',
      roleNames: [PLATFORM_SYSTEM_ROLES.USER_ADMIN, PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
      userId: 'u1',
    });
    expect(parsed.roleNames).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  });

  it('rejects past expiresAt', () => {
    expect(() =>
      adminUsersReplaceGlobalRolesInputSchema.parse({
        expiresAt: new Date(Date.now() - 1000),
        reason: 'r',
        roleNames: [],
        userId: 'u1',
      }),
    ).toThrow();
  });
});

describe('adminUsersGetAuditTrailInputSchema', () => {
  it('defaults limit and requires userId', () => {
    const parsed = adminUsersGetAuditTrailInputSchema.parse({ userId: 'u1' });
    expect(parsed.limit).toBe(ADMIN_USERS_LIST_DEFAULT_LIMIT);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LastSuperAdminError } from '../platformRbac';

const setBanned = vi.fn(async () => ({ banExpires: null, banned: true, id: 'u1' }));
const revokeAuthSessions = vi.fn(async () => ({ revokedCount: 1, tokens: ['tok-u1'] }));
const findBanState = vi.fn(async () => ({ banned: false }));
const isGlobalSuperAdmin = vi.fn(async () => false);
const markAutoBanned = vi.fn(async () => undefined);
const append = vi.fn(async () => ({ id: 'audit-1' }));
const deleteBetterAuthSecondaryStorageSessions = vi.fn(async () => undefined);

vi.mock('@/database/models/adminUser', () => ({
  AdminUserModel: class {
    findBanState = findBanState;
    revokeAuthSessions = revokeAuthSessions;
    setBanned = setBanned;
  },
}));

vi.mock('@/database/models/rbac', () => ({
  LastSuperAdminProtectionError: class extends Error {
    name = 'LastSuperAdminProtectionError';
  },
  RbacModel: class {
    isGlobalSuperAdmin = isGlobalSuperAdmin;
  },
}));

vi.mock('@/database/models/platform/contentModerationRecords', () => ({
  PlatformContentModerationRecordModel: class {
    markAutoBanned = markAutoBanned;
  },
}));

vi.mock('@/database/models/platform/auditLog', () => ({
  PlatformAuditLogModel: class {
    append = append;
  },
}));

vi.mock('./betterAuthSecondaryStorage', () => ({
  deleteBetterAuthSecondaryStorageSessions,
}));

vi.mock('@/libs/oidc-provider/access-control', () => ({
  revokeOIDCArtifactsByUserId: vi.fn(async () => undefined),
}));

vi.mock('../platformRbac', async () => {
  class LastSuperAdminError extends Error {
    readonly code = 'PLATFORM_LAST_SUPER_ADMIN';
    constructor(message = 'PLATFORM_LAST_SUPER_ADMIN') {
      super(message);
      this.name = 'LastSuperAdminError';
    }
  }
  return {
    LastSuperAdminError,
    PlatformRbacService: class {},
  };
});

const { AdminUserLifecycleService } = await import('./lifecycleService');

describe('AdminUserLifecycleService.systemBan', () => {
  const input = { reason: '内容审计：窗口内违规 10 次', userId: 'u1' };

  beforeEach(() => {
    setBanned.mockClear();
    revokeAuthSessions.mockClear();
    markAutoBanned.mockClear();
    append.mockClear();
    deleteBetterAuthSecondaryStorageSessions.mockClear();
    isGlobalSuperAdmin.mockReset();
    isGlobalSuperAdmin.mockResolvedValue(false);
    findBanState.mockResolvedValue({ banned: false });
    append.mockResolvedValue({ id: 'audit-1' });
  });

  it('refuses to ban a user who holds super_admin', async () => {
    isGlobalSuperAdmin.mockResolvedValue(true);
    let rolledBack = false;
    const db = {
      transaction: async (fn: (tx: { execute: () => Promise<void> }) => Promise<unknown>) => {
        try {
          return await fn({ execute: async () => undefined });
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    };
    const service = new AdminUserLifecycleService(db as never, {
      invalidation: { publish: vi.fn() },
    });
    await expect(service.systemBan({ input, recordId: 'rec-1' })).rejects.toBeInstanceOf(
      LastSuperAdminError,
    );
    expect(setBanned).not.toHaveBeenCalled();
    expect(rolledBack).toBe(true);
  });

  it('rolls back the ban when the audit append fails', async () => {
    append.mockRejectedValue(new Error('audit down'));
    let rolledBack = false;
    const db = {
      transaction: async (fn: (tx: { execute: () => Promise<void> }) => Promise<unknown>) => {
        try {
          return await fn({ execute: async () => undefined });
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    };
    const service = new AdminUserLifecycleService(db as never, {
      invalidation: { publish: vi.fn() },
    });
    await expect(service.systemBan({ input, recordId: 'rec-1' })).rejects.toThrow('audit down');
    expect(rolledBack).toBe(true);
    expect(markAutoBanned).toHaveBeenCalled();
    expect(setBanned).toHaveBeenCalled();
    expect(deleteBetterAuthSecondaryStorageSessions).not.toHaveBeenCalled();
  });

  it('evicts Better Auth secondary storage tokens returned by the session delete', async () => {
    const db = {
      transaction: async (fn: (tx: { execute: () => Promise<void> }) => Promise<unknown>) =>
        fn({ execute: async () => undefined }),
    };
    const service = new AdminUserLifecycleService(db as never, {
      invalidation: { publish: vi.fn() },
    });

    await expect(service.systemBan({ input, recordId: 'rec-1' })).resolves.toMatchObject({
      banned: true,
      userId: 'u1',
    });
    expect(revokeAuthSessions).toHaveBeenCalledWith({ userId: 'u1' });
    expect(deleteBetterAuthSecondaryStorageSessions).toHaveBeenCalledWith(['tok-u1']);
  });
});

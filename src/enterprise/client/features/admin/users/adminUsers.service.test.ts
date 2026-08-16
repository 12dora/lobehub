import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const mutate = vi.fn();

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      users: {
        list: { query: (...a: unknown[]) => query('list', ...a) },
        get: { query: (...a: unknown[]) => query('get', ...a) },
        getAuditTrail: { query: (...a: unknown[]) => query('audit', ...a) },
        create: { mutate: (...a: unknown[]) => mutate('create', ...a) },
        ban: { mutate: (...a: unknown[]) => mutate('ban', ...a) },
        unban: { mutate: (...a: unknown[]) => mutate('unban', ...a) },
        delete: { mutate: (...a: unknown[]) => mutate('delete', ...a) },
        revokeSessions: { mutate: (...a: unknown[]) => mutate('revoke', ...a) },
        replaceGlobalRoles: { mutate: (...a: unknown[]) => mutate('roles', ...a) },
      },
    },
  },
}));

describe('adminUsersService', () => {
  beforeEach(() => {
    query.mockReset();
    mutate.mockReset();
    query.mockResolvedValue({ ok: true });
    mutate.mockResolvedValue({ ok: true });
  });

  it('wraps all procedures without client-side Zod', async () => {
    const { adminUsersService } = await import('@/enterprise/client/services/adminUsers');

    await adminUsersService.list({ limit: 20, offset: 0, query: 'alice', source: 'local' });
    await adminUsersService.create({
      email: 'new@example.com',
      fullName: 'New User',
      password: 'Sup3r-secret!',
      reason: 'provision',
    });
    await adminUsersService.get({ userId: 'u1' });
    await adminUsersService.getAuditTrail({ userId: 'u1', limit: 10 });
    await adminUsersService.ban({ userId: 'u1', reason: 'abuse' });
    await adminUsersService.unban({ userId: 'u1', reason: 'appeal' });
    await adminUsersService.deleteUser({ userId: 'u1', reason: 'offboard' });
    await adminUsersService.revokeSessions({ userId: 'u1', reason: 'reset', includeCurrent: true });
    await adminUsersService.replaceGlobalRoles({
      userId: 'u1',
      reason: 'grant',
      roleNames: ['user_admin'],
    });

    expect(query).toHaveBeenCalledWith('list', {
      limit: 20,
      offset: 0,
      query: 'alice',
      source: 'local',
    });
    expect(query).toHaveBeenCalledWith('get', { userId: 'u1' });
    expect(query).toHaveBeenCalledWith('audit', { userId: 'u1', limit: 10 });
    expect(mutate).toHaveBeenCalledWith('create', {
      email: 'new@example.com',
      fullName: 'New User',
      password: 'Sup3r-secret!',
      reason: 'provision',
    });
    expect(mutate).toHaveBeenCalledWith('ban', { userId: 'u1', reason: 'abuse' });
    expect(mutate).toHaveBeenCalledWith('unban', { userId: 'u1', reason: 'appeal' });
    expect(mutate).toHaveBeenCalledWith('delete', { userId: 'u1', reason: 'offboard' });
    expect(mutate).toHaveBeenCalledWith('revoke', {
      userId: 'u1',
      reason: 'reset',
      includeCurrent: true,
    });
    expect(mutate).toHaveBeenCalledWith('roles', {
      userId: 'u1',
      reason: 'grant',
      roleNames: ['user_admin'],
    });
  });
});

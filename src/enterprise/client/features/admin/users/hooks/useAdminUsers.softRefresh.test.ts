/**
 * Post-commit soft refresh: mutation success must not become a mutation failure
 * when SWR invalidation rejects.
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminUserMutations } from './useAdminUsers';

const toastWarning = vi.fn();
const mutateMock = vi.fn();
const banMock = vi.fn();

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { warning: (...args: unknown[]) => toastWarning(...args) },
}));

vi.mock('i18next', () => ({
  default: {
    t: (key: string) => key,
  },
}));

vi.mock('swr', () => ({
  mutate: (...args: unknown[]) => mutateMock(...args),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: vi.fn(),
}));

vi.mock('@/enterprise/client/services/adminUsers', () => ({
  adminUsersService: {
    ban: (...args: unknown[]) => banMock(...args),
    create: vi.fn(),
    deleteUser: vi.fn(),
    get: vi.fn(),
    getAuditTrail: vi.fn(),
    list: vi.fn(),
    replaceGlobalRoles: vi.fn(),
    revokeSessions: vi.fn(),
    unban: vi.fn(),
  },
}));

describe('useAdminUserMutations soft refresh', () => {
  beforeEach(() => {
    toastWarning.mockReset();
    mutateMock.mockReset();
    banMock.mockReset();
  });

  it('resolves the mutation and warns when post-commit refresh fails', async () => {
    const committed = { ok: true as const };
    banMock.mockResolvedValue(committed);
    mutateMock.mockRejectedValue(new Error('SWR_REFRESH_FAILED'));

    const { result } = renderHook(() => useAdminUserMutations());
    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.banUser({ reason: 'spam', userId: 'u1' });
    });

    expect(resolved).toEqual(committed);
    expect(banMock).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalled();
    // Must not rethrow — callers must not treat this as a failed ban.
  });

  it('resolves cleanly when refresh succeeds (no warning toast)', async () => {
    const committed = { ok: true as const };
    banMock.mockResolvedValue(committed);
    mutateMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useAdminUserMutations());
    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.banUser({ reason: 'spam', userId: 'u1' });
    });

    expect(resolved).toEqual(committed);
    expect(toastWarning).not.toHaveBeenCalled();
  });
});

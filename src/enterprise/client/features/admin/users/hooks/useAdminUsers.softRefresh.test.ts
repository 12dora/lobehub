/**
 * Post-commit soft refresh: mutation success must not become a mutation failure
 * when SWR invalidation rejects. Independent invalidations must all be attempted.
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_USERS_AUDIT_KEY, ADMIN_USERS_DETAIL_KEY, ADMIN_USERS_LIST_KEY } from '../swrKeys';
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

/** Classify a mutate() call as list / detail / audit invalidation. */
const classifyMutateArg = (arg: unknown): 'list' | 'detail' | 'audit' | 'other' => {
  if (typeof arg === 'function') {
    // Predicate matchers used for list + audit fan-out.
    if (arg([ADMIN_USERS_LIST_KEY])) return 'list';
    if (arg([ADMIN_USERS_AUDIT_KEY, 'u1'])) return 'audit';
    return 'other';
  }
  if (Array.isArray(arg) && arg[0] === ADMIN_USERS_DETAIL_KEY) return 'detail';
  return 'other';
};

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
    expect(toastWarning).toHaveBeenCalledTimes(1);
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

  it('still attempts detail + audit invalidation when list invalidation rejects', async () => {
    const committed = { ok: true as const };
    banMock.mockResolvedValue(committed);

    // First matching call is list (predicate); detail + audit succeed after list fails.
    mutateMock.mockImplementation(async (arg: unknown) => {
      const kind = classifyMutateArg(arg);
      if (kind === 'list') throw new Error('LIST_REFRESH_FAILED');
      return undefined;
    });

    const { result } = renderHook(() => useAdminUserMutations());
    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.banUser({ reason: 'spam', userId: 'u1' });
    });

    expect(resolved).toEqual(committed);
    expect(banMock).toHaveBeenCalledTimes(1);

    const kinds = mutateMock.mock.calls.map(([arg]) => classifyMutateArg(arg));
    expect(kinds).toEqual(expect.arrayContaining(['list', 'detail', 'audit']));
    expect(kinds.filter((k) => k === 'list')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'detail')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'audit')).toHaveLength(1);
    // Exactly one warning for any partial failure set.
    expect(toastWarning).toHaveBeenCalledTimes(1);
  });
});

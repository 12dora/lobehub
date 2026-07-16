import { describe, expect, it, vi } from 'vitest';

import {
  fetchAdminAccess,
  getAdminAccessErrorCode,
  isAdminAccessErrorRetryable,
} from './adminAuth';

const query = vi.fn();

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      auth: {
        getMyAccess: {
          query: (...args: unknown[]) => query(...args),
        },
      },
    },
  },
}));

describe('adminAuth adapter', () => {
  it('fetchAdminAccess calls admin.auth.getMyAccess', async () => {
    query.mockResolvedValueOnce({
      hasAdminAccess: true,
      permissions: ['platform_admin:access:all'],
      roles: [{ displayName: 'Super', name: 'super_admin' }],
    });

    const result = await fetchAdminAccess();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result.hasAdminAccess).toBe(true);
    expect(result.permissions).toContain('platform_admin:access:all');
  });

  it('classifies UNAUTHORIZED / FORBIDDEN as non-retryable', () => {
    expect(isAdminAccessErrorRetryable({ data: { code: 'UNAUTHORIZED' } })).toBe(false);
    expect(isAdminAccessErrorRetryable({ data: { code: 'FORBIDDEN' } })).toBe(false);
    expect(isAdminAccessErrorRetryable({ data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(true);
    expect(isAdminAccessErrorRetryable(new Error('network down'))).toBe(true);
  });

  it('reads error codes from common tRPC shapes', () => {
    expect(getAdminAccessErrorCode({ data: { code: 'UNAUTHORIZED' } })).toBe('UNAUTHORIZED');
    expect(getAdminAccessErrorCode({ shape: { data: { code: 'FORBIDDEN' } } })).toBe('FORBIDDEN');
    expect(getAdminAccessErrorCode(null)).toBeUndefined();
  });
});

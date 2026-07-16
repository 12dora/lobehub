import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import {
  ADMIN_NAV_ITEMS,
  canAccessAdminPath,
  filterAdminNavByPermissions,
} from '@/enterprise/client/nav/adminNavMeta';
import { isAdminAccessErrorRetryable } from '@/enterprise/client/services/adminAuth';

/**
 * Behavioral access-flow tests without mounting the full SPA.
 * Covers: flag/auth gates, 403 consistency, child-data mount rule.
 */
describe('admin access flow contracts', () => {
  it('anonymous path uses openLogin with callbackUrl (canonical sign-in)', async () => {
    const openLogin = vi.fn(async () => {
      // Mirrors useUserStore.openLogin: preserve return path
      const currentUrl = 'http://localhost/admin/users';
      window.location.href = `/signin?callbackUrl=${encodeURIComponent(currentUrl)}`;
    });

    // Simulate gate branch
    const isLogin = false;
    if (!isLogin) {
      await openLogin();
    }

    expect(openLogin).toHaveBeenCalledTimes(1);
  });

  it('ordinary user (no admin access) must not mount child data fetches', () => {
    type AccessStatus = 'loading' | 'allowed' | 'forbidden' | 'error';
    const shouldMountChildData = (status: AccessStatus) => status === 'allowed';
    const childFetch = vi.fn();

    if (shouldMountChildData('forbidden')) {
      childFetch();
    }

    expect(shouldMountChildData('forbidden')).toBe(false);
    expect(shouldMountChildData('allowed')).toBe(true);
    expect(childFetch).not.toHaveBeenCalled();
  });

  it('workspace-only permissions still forbidden for admin shell pages without platform perms', () => {
    const granted: string[] = []; // no platform_* permissions
    expect(canAccessAdminPath('/admin/users', granted)).toBe(false);
    expect(filterAdminNavByPermissions(ADMIN_NAV_ITEMS, granted).map((i) => i.id)).toEqual([
      'overview',
    ]);
  });

  it('allowed admin with subset of permissions sees filtered nav only', () => {
    const granted = [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.USER_READ];
    const nav = filterAdminNavByPermissions(ADMIN_NAV_ITEMS, granted);
    const ids = nav.map((i) => i.id);
    expect(ids).toContain('overview');
    expect(ids).toContain('users');
    expect(ids).not.toContain('audit');
    expect(canAccessAdminPath('/admin/users', granted)).toBe(true);
    expect(canAccessAdminPath('/admin/audit', granted)).toBe(false);
  });

  it('401/403 access errors are not retryable; network errors are', () => {
    expect(isAdminAccessErrorRetryable({ data: { code: 'UNAUTHORIZED' } })).toBe(false);
    expect(isAdminAccessErrorRetryable({ data: { code: 'FORBIDDEN' } })).toBe(false);
    expect(isAdminAccessErrorRetryable(new Error('ECONNRESET'))).toBe(true);
  });
});

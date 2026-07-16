import { describe, expect, it, vi } from 'vitest';

import { BusinessDesktopRoutesWithoutMainLayout } from '@/business/client/BusinessDesktopRoutes';

import { fetchAdminAccess } from '../services/adminAuth';
import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from '../services/platform';
import { EnterpriseDesktopRoutesWithoutMainLayout, resolveEnterpriseDesktopRoutes } from './index';

vi.mock('../services/platform', () => ({
  fetchPlatformCapabilities: vi.fn(async () => ({})),
  fetchPlatformPublicSnapshot: vi.fn(async () => ({})),
}));

vi.mock('../services/adminAuth', () => ({
  fetchAdminAccess: vi.fn(async () => ({
    hasAdminAccess: false,
    permissions: [],
    roles: [],
  })),
}));

/**
 * Flag-off regression (M03):
 * - Effective route tree excludes /admin when platformAdmin is false
 * - Importing route modules alone must not call platform.* or admin.*
 * - Network gates remain in EnterprisePlatformProvider / AdminRootGate
 */
describe('enterprise routes flag-off regression', () => {
  it('effective routes empty when platformAdmin is false', () => {
    expect(resolveEnterpriseDesktopRoutes({ platformAdmin: false })).toEqual([]);
  });

  it('production mount includes gated /admin path for deep-link resolution after boot', () => {
    const hasAdmin = EnterpriseDesktopRoutesWithoutMainLayout.some((r) => r.path === '/admin');
    expect(hasAdmin).toBe(true);
    const businessHasAdmin = BusinessDesktopRoutesWithoutMainLayout.some(
      (r) => r.path === '/admin',
    );
    expect(businessHasAdmin).toBe(true);
  });

  it('importing routes does not auto-invoke platform.* or admin.*', () => {
    expect(fetchPlatformCapabilities).not.toHaveBeenCalled();
    expect(fetchPlatformPublicSnapshot).not.toHaveBeenCalled();
    expect(fetchAdminAccess).not.toHaveBeenCalled();
  });
});

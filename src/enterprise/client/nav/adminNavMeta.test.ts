import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import {
  ADMIN_NAV_FLAT,
  ADMIN_NAV_ITEMS,
  canAccessAdminPath,
  filterAdminNavByPermissions,
  findAdminNavItemByPath,
  getAdminBreadcrumbs,
  hasAllPermissions,
} from './adminNavMeta';

describe('adminNavMeta', () => {
  it('declares planned routes with permissions (single catalog)', () => {
    const paths = ADMIN_NAV_FLAT.map((i) => i.path);
    expect(paths).toContain('/admin');
    expect(paths).toContain('/admin/users');
    expect(paths).toContain('/admin/ai/providers');
    expect(paths).toContain('/admin/identity/providers');
    expect(findAdminNavItemByPath('/admin/users')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.USER_READ,
    ]);
  });

  it('filters menu and route access from the same permission declaration', () => {
    const granted = [
      PLATFORM_PERMISSIONS.ADMIN_ACCESS,
      PLATFORM_PERMISSIONS.USER_READ,
      PLATFORM_PERMISSIONS.AUDIT_READ,
    ];

    const nav = filterAdminNavByPermissions(ADMIN_NAV_ITEMS, granted);
    const navPaths = nav.flatMap((item) => [
      item.path,
      ...(item.children?.map((c) => c.path) ?? []),
    ]);

    expect(navPaths).toContain('/admin');
    expect(navPaths).toContain('/admin/users');
    expect(navPaths).toContain('/admin/audit');
    expect(navPaths).not.toContain('/admin/settings');
    expect(navPaths).not.toContain('/admin/ai/providers');

    expect(canAccessAdminPath('/admin/users', granted)).toBe(true);
    expect(canAccessAdminPath('/admin/settings', granted)).toBe(false);
    expect(canAccessAdminPath('/admin/ai/providers', granted)).toBe(false);
  });

  it('keeps AI group when a child permission is granted', () => {
    const granted = [PLATFORM_PERMISSIONS.AI_PROVIDER_READ];
    const nav = filterAdminNavByPermissions(ADMIN_NAV_ITEMS, granted);
    const ai = nav.find((i) => i.id === 'ai');
    expect(ai?.children?.map((c) => c.id)).toEqual(['ai-providers']);
  });

  it('builds breadcrumbs without drift from nav catalog', () => {
    const crumbs = getAdminBreadcrumbs('/admin/ai/providers');
    expect(crumbs.map((c) => c.path)).toEqual(['/admin', '/admin/ai', '/admin/ai/providers']);
  });

  it('hasAllPermissions requires every code', () => {
    expect(hasAllPermissions(['a', 'b'], ['a'])).toBe(true);
    expect(hasAllPermissions(['a'], ['a', 'b'])).toBe(false);
    expect(hasAllPermissions(['a'], [])).toBe(true);
  });
});

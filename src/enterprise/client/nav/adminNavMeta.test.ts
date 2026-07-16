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
  it('declares list and hidden detail routes with distinct permissions', () => {
    expect(findAdminNavItemByPath('/admin/users')?.id).toBe('users');
    expect(findAdminNavItemByPath('/admin/users/u1')?.id).toBe('users-detail');
    expect(findAdminNavItemByPath('/admin/users/u1')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.USER_READ,
    ]);

    expect(findAdminNavItemByPath('/admin/ai/providers')?.id).toBe('ai-providers');
    expect(findAdminNavItemByPath('/admin/ai/providers/p1')?.id).toBe('ai-provider-detail');
    expect(findAdminNavItemByPath('/admin/ai/providers/p1')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
    ]);
    expect(findAdminNavItemByPath('/admin/managed-resources')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.POLICY_READ,
    ]);
  });

  it('most-specific matchPath wins — list READ does not grant provider edit', () => {
    const readOnly = [PLATFORM_PERMISSIONS.AI_PROVIDER_READ];
    expect(canAccessAdminPath('/admin/ai/providers', readOnly)).toBe(true);
    expect(canAccessAdminPath('/admin/ai/providers/p1', readOnly)).toBe(false);

    const updater = [PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE];
    expect(canAccessAdminPath('/admin/ai/providers/p1', updater)).toBe(true);
  });

  it('shows and guards managed resources with policy read permission only', () => {
    expect(canAccessAdminPath('/admin/managed-resources', [])).toBe(false);
    expect(canAccessAdminPath('/admin/managed-resources', [PLATFORM_PERMISSIONS.POLICY_READ])).toBe(
      true,
    );
    const nav = filterAdminNavByPermissions(ADMIN_NAV_ITEMS, [PLATFORM_PERMISSIONS.POLICY_READ]);
    expect(nav.map((item) => item.id)).toContain('managed-resources');
  });

  it('unknown nested path has no catalog entry (admin 404)', () => {
    expect(findAdminNavItemByPath('/admin/does-not-exist')).toBeUndefined();
    expect(canAccessAdminPath('/admin/does-not-exist', [PLATFORM_PERMISSIONS.ADMIN_ACCESS])).toBe(
      false,
    );
  });

  it('filters menu without hidden detail items; same source as route guards', () => {
    const granted = [
      PLATFORM_PERMISSIONS.ADMIN_ACCESS,
      PLATFORM_PERMISSIONS.USER_READ,
      PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
    ];

    const nav = filterAdminNavByPermissions(ADMIN_NAV_ITEMS, granted);
    const flatIds = nav.flatMap((item) => [item.id, ...(item.children?.map((c) => c.id) ?? [])]);

    expect(flatIds).toContain('users');
    expect(flatIds).toContain('ai-providers');
    expect(flatIds).not.toContain('users-detail');
    expect(flatIds).not.toContain('ai-provider-detail');
    expect(flatIds).not.toContain('audit');

    expect(canAccessAdminPath('/admin/users', granted)).toBe(true);
    expect(canAccessAdminPath('/admin/users/abc', granted)).toBe(true);
    expect(canAccessAdminPath('/admin/ai/providers/p1', granted)).toBe(false);
  });

  it('builds breadcrumbs for detail paths', () => {
    const crumbs = getAdminBreadcrumbs('/admin/ai/providers/p1');
    expect(crumbs.map((c) => c.id)).toEqual(
      expect.arrayContaining(['overview', 'ai-providers', 'ai-provider-detail']),
    );
  });

  it('hasAllPermissions requires every code', () => {
    expect(hasAllPermissions(['a', 'b'], ['a'])).toBe(true);
    expect(hasAllPermissions(['a'], ['a', 'b'])).toBe(false);
    expect(ADMIN_NAV_FLAT.some((i) => i.path.includes(':id'))).toBe(true);
  });
});

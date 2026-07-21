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
      PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
    ]);
    expect(findAdminNavItemByPath('/admin/managed-resources')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.POLICY_READ,
    ]);
    expect(findAdminNavItemByPath('/admin/ai/skills')?.id).toBe('ai-skills');
    expect(findAdminNavItemByPath('/admin/ai/skills/s1')?.id).toBe('ai-skill-detail');
    expect(findAdminNavItemByPath('/admin/ai/skills/s1')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.SKILL_READ,
    ]);
    expect(findAdminNavItemByPath('/admin/skills')?.id).toBe('skills');
    expect(findAdminNavItemByPath('/admin/skills/s1')?.id).toBe('skills-detail');
    expect(findAdminNavItemByPath('/admin/skills/s1')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.SKILL_READ,
    ]);
    expect(findAdminNavItemByPath('/admin/ai/connectors')?.id).toBe('ai-connectors');
    expect(findAdminNavItemByPath('/admin/ai/connectors/c1')?.id).toBe('ai-connector-detail');
    expect(findAdminNavItemByPath('/admin/agents')?.id).toBe('agents');
    expect(findAdminNavItemByPath('/admin/agents/a1')?.id).toBe('agents-detail');
    expect(findAdminNavItemByPath('/admin/agents/a1')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.AGENT_READ,
    ]);
    expect(findAdminNavItemByPath('/admin/system')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.SYSTEM_READ,
    ]);
    expect(findAdminNavItemByPath('/admin/system')?.placeholder).toBe(false);
  });

  it('lets Provider auditors inspect detail without granting write actions', () => {
    const readOnly = [PLATFORM_PERMISSIONS.AI_PROVIDER_READ];
    expect(canAccessAdminPath('/admin/ai/providers', readOnly)).toBe(true);
    expect(canAccessAdminPath('/admin/ai/providers/p1', readOnly)).toBe(true);

    const updater = [
      PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
      PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
    ];
    expect(canAccessAdminPath('/admin/ai/providers/p1', updater)).toBe(true);
  });

  it('guards managed resources by policy read; surfaces the unified-management nav item', () => {
    expect(canAccessAdminPath('/admin/managed-resources', [])).toBe(false);
    expect(canAccessAdminPath('/admin/managed-resources', [PLATFORM_PERMISSIONS.POLICY_READ])).toBe(
      true,
    );
    // `settings` + `managed-resources` are now hidden back-compat routes; the visible surface
    // is the merged `unified-management` tab (shell-only gate, each in-page tab self-gates).
    expect(canAccessAdminPath('/admin/unified', [])).toBe(true);
    const nav = filterAdminNavByPermissions(ADMIN_NAV_ITEMS, [PLATFORM_PERMISSIONS.POLICY_READ]);
    const ids = nav.map((item) => item.id);
    expect(ids).toContain('unified-management');
    expect(ids).not.toContain('managed-resources');
    expect(ids).not.toContain('settings');
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
    expect(flatIds).not.toContain('ai-skill-detail');
    expect(flatIds).not.toContain('skills');
    expect(flatIds).not.toContain('skills-detail');
    expect(flatIds).not.toContain('connectors');
    expect(flatIds).not.toContain('audit');

    expect(canAccessAdminPath('/admin/users', granted)).toBe(true);
    expect(canAccessAdminPath('/admin/users/abc', granted)).toBe(true);
    expect(canAccessAdminPath('/admin/ai/providers/p1', granted)).toBe(true);
  });

  it('builds breadcrumbs for detail paths', () => {
    const crumbs = getAdminBreadcrumbs('/admin/ai/providers/p1');
    expect(crumbs.map((c) => c.id)).toEqual(
      expect.arrayContaining(['overview', 'ai-providers', 'ai-provider-detail']),
    );
    expect(getAdminBreadcrumbs('/admin/skills/s1').map((c) => c.id)).toEqual(
      expect.arrayContaining(['overview', 'skills', 'skills-detail']),
    );
    expect(getAdminBreadcrumbs('/admin/agents/a1').map((c) => c.id)).toEqual(
      expect.arrayContaining(['overview', 'agents', 'agents-detail']),
    );
  });

  it('hasAllPermissions requires every code', () => {
    expect(hasAllPermissions(['a', 'b'], ['a'])).toBe(true);
    expect(hasAllPermissions(['a'], ['a', 'b'])).toBe(false);
    expect(ADMIN_NAV_FLAT.some((i) => i.path.includes(':id'))).toBe(true);
  });
});

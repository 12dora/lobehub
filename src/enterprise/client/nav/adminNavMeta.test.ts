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
    // 任务模板 reuses the platform-agent permissions so no extra RBAC seeding is needed.
    expect(findAdminNavItemByPath('/admin/ai/task-templates')?.id).toBe('task-templates');
    expect(findAdminNavItemByPath('/admin/ai/task-templates')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.AGENT_READ,
    ]);
    expect(findAdminNavItemByPath('/admin/agents')?.id).toBe('agents');
    // Assistants are authored entirely in a modal — there is no detail route to fall back to.
    expect(findAdminNavItemByPath('/admin/agents/a1')).toBeUndefined();
    // `/admin/system` is now the group index (shell-only); the status page moved one level down.
    expect(findAdminNavItemByPath('/admin/system')?.id).toBe('system');
    expect(findAdminNavItemByPath('/admin/system')?.requiredPermissions).toEqual([]);
    expect(findAdminNavItemByPath('/admin/system/status')?.id).toBe('system-status');
    expect(findAdminNavItemByPath('/admin/system/status')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.SYSTEM_READ,
    ]);
    expect(findAdminNavItemByPath('/admin/system/general')?.id).toBe('system-general');
    expect(findAdminNavItemByPath('/admin/system/general')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.SYSTEM_READ,
    ]);
  });

  it('nests the system group children while keeping their historical paths', () => {
    const system = ADMIN_NAV_ITEMS.find((item) => item.id === 'system');
    expect(system?.requiredPermissions).toEqual([]);
    // `/admin/system` was the status page before the group existed — keep that bookmark working.
    expect(system?.indexRedirectTo).toBe('system-status');
    expect(system?.children?.some((c) => c.id === system.indexRedirectTo)).toBe(true);
    expect(system?.children?.filter((c) => !c.hideFromNav).map((c) => c.id)).toEqual([
      'system-general',
      'users',
      'unified-management',
      'system-status',
      'identity-providers',
      'branding',
    ]);
    // Paths are unchanged so existing deep links / bookmarks keep working.
    expect(findAdminNavItemByPath('/admin/users')?.id).toBe('users');
    expect(findAdminNavItemByPath('/admin/branding')?.id).toBe('branding');
    expect(findAdminNavItemByPath('/admin/identity-providers')?.id).toBe('identity-providers');
    expect(findAdminNavItemByPath('/admin/unified')?.id).toBe('unified-management');

    // The group is visible as soon as a single child is allowed.
    const nav = filterAdminNavByPermissions(ADMIN_NAV_ITEMS, [PLATFORM_PERMISSIONS.BRANDING_READ]);
    expect(nav.find((item) => item.id === 'system')?.children?.map((c) => c.id)).toEqual([
      'unified-management',
      'branding',
    ]);
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
    // `unified-management` now lives inside the `system` group (paths unchanged).
    const ids = nav.flatMap((item) => [item.id, ...(item.children?.map((c) => c.id) ?? [])]);
    expect(ids).toContain('unified-management');
    expect(nav.map((item) => item.id)).not.toContain('unified-management');
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
    expect(flatIds).not.toContain('audit-logs');

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
  });

  it('includes the nav group crumb even when a child keeps a path outside the group prefix', () => {
    expect(getAdminBreadcrumbs('/admin/users').map((c) => c.id)).toEqual([
      'overview',
      'system',
      'users',
    ]);
    expect(getAdminBreadcrumbs('/admin/users/u1').map((c) => c.id)).toEqual([
      'overview',
      'system',
      'users',
      'users-detail',
    ]);
    expect(getAdminBreadcrumbs('/admin/system/status').map((c) => c.id)).toEqual([
      'overview',
      'system',
      'system-status',
    ]);
    // Existing groups whose children do nest under the group path are unchanged.
    expect(getAdminBreadcrumbs('/admin/audit/logs').map((c) => c.id)).toEqual([
      'overview',
      'audit',
      'audit-logs',
    ]);
  });

  it('hasAllPermissions requires every code', () => {
    expect(hasAllPermissions(['a', 'b'], ['a'])).toBe(true);
    expect(hasAllPermissions(['a'], ['a', 'b'])).toBe(false);
    expect(ADMIN_NAV_FLAT.some((i) => i.path.includes(':id'))).toBe(true);
  });

  it('registers audit group children with distinct permissions', () => {
    expect(findAdminNavItemByPath('/admin/audit/logs')?.id).toBe('audit-logs');
    expect(findAdminNavItemByPath('/admin/audit/logs')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.AUDIT_READ,
    ]);
    expect(findAdminNavItemByPath('/admin/audit/conversations')?.id).toBe('audit-conversations');
    expect(findAdminNavItemByPath('/admin/audit/conversations/u1')?.id).toBe(
      'audit-conversation-user',
    );
    expect(findAdminNavItemByPath('/admin/audit/conversations/u1/topics/t1')?.id).toBe(
      'audit-conversation-topic',
    );
    expect(findAdminNavItemByPath('/admin/audit/exports')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.AUDIT_EXPORT,
    ]);
    expect(findAdminNavItemByPath('/admin/audit/holds')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE,
    ]);
    expect(findAdminNavItemByPath('/admin/audit/retention')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE,
    ]);

    const nav = filterAdminNavByPermissions(ADMIN_NAV_ITEMS, [PLATFORM_PERMISSIONS.AUDIT_READ]);
    const audit = nav.find((item) => item.id === 'audit');
    expect(audit?.children?.map((c) => c.id)).toEqual(['audit-logs']);

    expect(findAdminNavItemByPath('/admin/audit/live')?.id).toBe('audit-live');
    expect(findAdminNavItemByPath('/admin/audit/live')?.requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ,
    ]);
  });
});

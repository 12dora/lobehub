import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ADMIN_NAV_ICONS, assertAdminNavIconsComplete } from '@/enterprise/client/nav/adminIcons';
import { ADMIN_NAV_FLAT, ADMIN_NAV_ITEMS } from '@/enterprise/client/nav/adminNavMeta';
import {
  ADMIN_PAGE_BY_ID,
  getAdminPageComponentId,
} from '@/enterprise/client/nav/adminPageCatalog';

import { createAdminRouteTree } from './createAdminRouteTree';

const collectPaths = (routes: ReturnType<typeof createAdminRouteTree>, prefix = ''): string[] => {
  const paths: string[] = [];
  for (const route of routes) {
    const path = route.path
      ? route.path.startsWith('/')
        ? route.path
        : `${prefix}/${route.path}`.replaceAll(/\/+/g, '/')
      : prefix;
    if (route.index) paths.push(prefix || '/');
    if (route.path) paths.push(path);
    if (route.children) {
      paths.push(...collectPaths(route.children as typeof routes, path || prefix));
    }
  }
  return [...new Set(paths)];
};

describe('createAdminRouteTree', () => {
  it('registers list and dynamic detail paths from the catalog', () => {
    const paths = collectPaths(createAdminRouteTree());
    expect(paths).toContain('/admin');
    expect(paths).toContain('/admin/users');
    expect(paths).toContain('/admin/users/:id');
    expect(paths).toContain('/admin/managed-resources');
    expect(paths).toContain('/admin/unified');
    expect(paths).toContain('/admin/ai/providers');
    expect(paths).toContain('/admin/ai/providers/:id');
    expect(paths).toContain('/admin/ai/service-model');
    expect(paths).toContain('/admin/ai/memory');
    // The hidden advanced draft/publish catalog is gone: admin provider writes apply
    // immediately from /admin/ai/providers, so no /admin/ai/catalog/* route may come back.
    expect(paths.some((path) => path.startsWith('/admin/ai/catalog'))).toBe(false);
    expect(paths).toContain('/admin/skills');
    expect(paths).toContain('/admin/skills/:id');
    expect(paths).toContain('/admin/connectors');
    expect(paths).toContain('/admin/connectors/:id');
    expect(paths).toContain('/admin/agents');
    // Assistants are authored in a modal — there is no detail route to register.
    expect(paths).not.toContain('/admin/agents/:id');
    expect(paths).toContain('/admin/branding');
    expect(paths).toContain('/admin/identity-providers');
    expect(paths).toContain('/admin/system');
    expect(paths).toContain('/admin/system/general');
    expect(paths).toContain('/admin/system/status');
    expect(paths).toContain('/admin/reauth-complete');
  });

  it('deep links match nested paths and nested 404', () => {
    const routes = createAdminRouteTree();

    expect(matchRoutes(routes, '/admin')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/users')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/users/u-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/managed-resources')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/unified')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/ai/providers/p-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/skills/s-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/connectors/c-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/agents/a-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/identity-providers')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/system')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/system/status')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/system/general')).toBeTruthy();
    const reauthComplete = matchRoutes(routes, '/admin/reauth-complete');
    expect(reauthComplete).toHaveLength(1);
    expect(reauthComplete?.[0].route.path).toBe('/admin/reauth-complete');

    const adminRoot = routes.find((route) => route.path === '/admin');
    expect(adminRoot?.children?.some((route) => route.path === 'reauth-complete')).toBe(false);

    const nestedUnknown = matchRoutes(routes, '/admin/does-not-exist');
    expect(nestedUnknown).toBeTruthy();
    expect(nestedUnknown?.at(-1)?.route.path).toBe('*');
  });

  it('every nav route resolves to a real page; group parents redirect (no placeholder surface)', () => {
    const routes = createAdminRouteTree();
    const admin = routes.find((r) => r.path === '/admin');
    const children = admin?.children ?? [];

    const componentIdOf = (path: string) =>
      (children.find((c) => c.path === path)?.handle as { admin?: { componentId?: string } })?.admin
        ?.componentId;

    // Leaf routes resolve to their real page components.
    expect(componentIdOf('users')).toBe('UsersListPage');
    expect(componentIdOf('users/:id')).toBe('UserDetailPage');
    expect(componentIdOf('agents')).toBe('AgentListPage');
    expect(componentIdOf('branding')).toBe('BrandingPage');
    expect(componentIdOf('ai/task-templates')).toBe('TaskTemplateListPage');
    expect(componentIdOf('system/status')).toBe('SystemPage');
    expect(componentIdOf('system/general')).toBe('SystemGeneralPage');

    // Group parents (/admin/ai, /admin/audit, /admin/system) are index redirects to the first
    // accessible child — never a "coming soon" placeholder surface.
    expect(componentIdOf('ai')).toBe('AiIndexRedirect');
    expect(componentIdOf('audit')).toBe('AuditIndexRedirect');
    expect(componentIdOf('system')).toBe('SystemIndexRedirect');

    // The /admin index route is the Overview dashboard.
    const index = children.find((c) => c.index);
    expect((index?.handle as { admin?: { componentId?: string } })?.admin?.componentId).toBe(
      'OverviewPage',
    );

    // Component identity comes from the single page catalog.
    expect(getAdminPageComponentId('users')).toBe('UsersListPage');
    expect(getAdminPageComponentId('connectors')).toBe('ConnectorListPage');
    // Unknown ids fall back to a scoped 404, not a "coming soon" placeholder (which no longer exists).
    expect(getAdminPageComponentId('unknown-future')).toBe('NotFoundPage');

    // Every registered nav id — leaves, hidden details, and group parents — resolves to a real
    // catalog entry; nothing silently falls through to the 404 fallback.
    for (const item of ADMIN_NAV_FLAT) {
      expect(ADMIN_PAGE_BY_ID[item.id]?.componentId, item.id).toBeTruthy();
      expect(ADMIN_PAGE_BY_ID[item.id]?.componentId, item.id).not.toBe('NotFoundPage');
    }

    // Nav-visible items have icons in the shared icon catalog.
    const visibleIds = ADMIN_NAV_FLAT.filter((i) => !i.hideFromNav).map((i) => i.id);
    const { missing } = assertAdminNavIconsComplete(visibleIds);
    expect(missing).toEqual([]);
    expect(ADMIN_NAV_ICONS.users).toBeTruthy();
    expect(ADMIN_NAV_ITEMS.length).toBeGreaterThan(0);
  });
});

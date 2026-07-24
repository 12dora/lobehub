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
    expect(paths).toContain('/admin/ai/catalog/providers');
    expect(paths).toContain('/admin/ai/catalog/providers/:id');
    expect(paths).toContain('/admin/ai/catalog/models');
    expect(paths).toContain('/admin/skills');
    expect(paths).toContain('/admin/skills/:id');
    expect(paths).toContain('/admin/connectors');
    expect(paths).toContain('/admin/connectors/:id');
    expect(paths).toContain('/admin/agents');
    expect(paths).toContain('/admin/agents/:id');
    expect(paths).toContain('/admin/branding');
    expect(paths).toContain('/admin/identity-providers');
    expect(paths).toContain('/admin/system');
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
    const reauthComplete = matchRoutes(routes, '/admin/reauth-complete');
    expect(reauthComplete).toHaveLength(1);
    expect(reauthComplete?.[0].route.path).toBe('/admin/reauth-complete');

    const adminRoot = routes.find((route) => route.path === '/admin');
    expect(adminRoot?.children?.some((route) => route.path === 'reauth-complete')).toBe(false);

    const nestedUnknown = matchRoutes(routes, '/admin/does-not-exist');
    expect(nestedUnknown).toBeTruthy();
    expect(nestedUnknown?.at(-1)?.route.path).toBe('*');
  });

  it('implemented admin routes are real pages; later modules remain placeholders', () => {
    const routes = createAdminRouteTree();
    const admin = routes.find((r) => r.path === '/admin');
    const children = admin?.children ?? [];

    const users = children.find((c) => c.path === 'users');
    const usersDetail = children.find((c) => c.path === 'users/:id');
    const settings = children.find((c) => c.path === 'settings');
    const managedResources = children.find((c) => c.path === 'managed-resources');
    const aiProviders = children.find((c) => c.path === 'ai/providers');
    const aiProviderDetail = children.find((c) => c.path === 'ai/providers/:id');
    const aiCatalogProviders = children.find((c) => c.path === 'ai/catalog/providers');
    const aiCatalogModels = children.find((c) => c.path === 'ai/catalog/models');
    const skills = children.find((c) => c.path === 'skills');
    const skillDetail = children.find((c) => c.path === 'skills/:id');
    const connectors = children.find((c) => c.path === 'connectors');
    const connectorDetail = children.find((c) => c.path === 'connectors/:id');
    const agents = children.find((c) => c.path === 'agents');
    const agentDetail = children.find((c) => c.path === 'agents/:id');
    const branding = children.find((c) => c.path === 'branding');
    const identityProviders = children.find((c) => c.path === 'identity-providers');
    const system = children.find((c) => c.path === 'system');

    expect((users?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect((usersDetail?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect((settings?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect(
      (managedResources?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder,
    ).toBe(false);
    expect((aiProviders?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect(
      (aiCatalogProviders?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder,
    ).toBe(false);
    expect(
      (aiCatalogModels?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder,
    ).toBe(false);
    expect(
      (aiProviderDetail?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder,
    ).toBe(false);
    expect((skills?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect((skillDetail?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect((connectors?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect(
      (connectorDetail?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder,
    ).toBe(false);
    expect((agents?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect((agentDetail?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect((branding?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect(
      (identityProviders?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder,
    ).toBe(false);
    expect((system?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );

    const auditLogs = children.find((c) => c.path === 'audit/logs');
    const auditLive = children.find((c) => c.path === 'audit/live');
    const auditExports = children.find((c) => c.path === 'audit/exports');
    const auditHolds = children.find((c) => c.path === 'audit/holds');
    const auditRetention = children.find((c) => c.path === 'audit/retention');
    expect((auditLogs?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect((auditLive?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect(
      (auditExports?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder,
    ).toBe(false);
    expect((auditHolds?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect(
      (auditRetention?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder,
    ).toBe(false);

    // Component identity from the single page catalog (not mere element truthiness).
    expect((users?.handle as { admin?: { componentId?: string } })?.admin?.componentId).toBe(
      'UsersListPage',
    );
    expect((usersDetail?.handle as { admin?: { componentId?: string } })?.admin?.componentId).toBe(
      'UserDetailPage',
    );
    expect(getAdminPageComponentId('users')).toBe('UsersListPage');
    expect(getAdminPageComponentId('connectors')).toBe('ConnectorListPage');
    expect(getAdminPageComponentId('unknown-future')).toBe('PlaceholderPage');

    // Every non-placeholder leaf catalog id resolves to a real page registry entry.
    // Group-only nodes (ai) may be placeholder; overview is the index route.
    for (const item of ADMIN_NAV_FLAT) {
      if (item.placeholder) continue;
      if (item.children?.length) continue; // pure group shells
      expect(ADMIN_PAGE_BY_ID[item.id]?.componentId, item.id).toBeTruthy();
      expect(ADMIN_PAGE_BY_ID[item.id]?.componentId, item.id).not.toBe('PlaceholderPage');
    }

    // Nav-visible items have icons in the shared icon catalog.
    const visibleIds = ADMIN_NAV_FLAT.filter((i) => !i.hideFromNav).map((i) => i.id);
    const { missing } = assertAdminNavIconsComplete(visibleIds);
    expect(missing).toEqual([]);
    expect(ADMIN_NAV_ICONS.users).toBeTruthy();
    expect(ADMIN_NAV_ITEMS.length).toBeGreaterThan(0);

    const placeholders = ADMIN_NAV_FLAT.filter((i) => i.placeholder);
    expect(
      placeholders.every(
        (i) =>
          i.id !== 'users' &&
          i.id !== 'users-detail' &&
          i.id !== 'managed-resources' &&
          i.id !== 'ai-providers' &&
          i.id !== 'ai-provider-detail' &&
          i.id !== 'ai-service-model' &&
          i.id !== 'ai-memory' &&
          i.id !== 'ai-catalog-providers' &&
          i.id !== 'ai-catalog-provider-detail' &&
          i.id !== 'ai-catalog-models' &&
          i.id !== 'skills' &&
          i.id !== 'skills-detail' &&
          i.id !== 'connectors' &&
          i.id !== 'connectors-detail' &&
          i.id !== 'agents' &&
          i.id !== 'agents-detail' &&
          i.id !== 'branding' &&
          i.id !== 'identity-providers' &&
          i.id !== 'system' &&
          i.id !== 'audit' &&
          !i.id.startsWith('audit-'),
      ),
    ).toBe(true);
  });
});

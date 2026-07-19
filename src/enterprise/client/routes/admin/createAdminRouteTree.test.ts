import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ADMIN_NAV_FLAT } from '@/enterprise/client/nav/adminNavMeta';

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
    expect(paths).toContain('/admin/ai/providers');
    expect(paths).toContain('/admin/ai/providers/:id');
    expect(paths).toContain('/admin/skills');
    expect(paths).toContain('/admin/skills/:id');
    expect(paths).toContain('/admin/connectors');
    expect(paths).toContain('/admin/connectors/:id');
    expect(paths).toContain('/admin/agents');
    expect(paths).toContain('/admin/agents/:id');
    expect(paths).toContain('/admin/branding');
    expect(paths).toContain('/admin/identity-providers');
  });

  it('deep links match nested paths and nested 404', () => {
    const routes = createAdminRouteTree();

    expect(matchRoutes(routes, '/admin')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/users')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/users/u-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/managed-resources')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/ai/providers/p-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/skills/s-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/connectors/c-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/agents/a-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/identity-providers')).toBeTruthy();

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
    const aiModels = children.find((c) => c.path === 'ai/models');
    const skills = children.find((c) => c.path === 'skills');
    const skillDetail = children.find((c) => c.path === 'skills/:id');
    const connectors = children.find((c) => c.path === 'connectors');
    const connectorDetail = children.find((c) => c.path === 'connectors/:id');
    const agents = children.find((c) => c.path === 'agents');
    const agentDetail = children.find((c) => c.path === 'agents/:id');
    const branding = children.find((c) => c.path === 'branding');
    const identityProviders = children.find((c) => c.path === 'identity-providers');

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
    expect((aiModels?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
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

    // Element is not the shared PlaceholderPage for users (lazy wrapper present)
    expect(users?.element).toBeTruthy();
    expect(usersDetail?.element).toBeTruthy();

    const placeholders = ADMIN_NAV_FLAT.filter((i) => i.placeholder);
    expect(
      placeholders.every(
        (i) =>
          i.id !== 'users' &&
          i.id !== 'users-detail' &&
          i.id !== 'managed-resources' &&
          i.id !== 'ai-providers' &&
          i.id !== 'ai-provider-detail' &&
          i.id !== 'ai-models' &&
          i.id !== 'skills' &&
          i.id !== 'skills-detail' &&
          i.id !== 'connectors' &&
          i.id !== 'connectors-detail' &&
          i.id !== 'agents' &&
          i.id !== 'agents-detail' &&
          i.id !== 'branding' &&
          i.id !== 'identity-providers',
      ),
    ).toBe(true);
  });
});

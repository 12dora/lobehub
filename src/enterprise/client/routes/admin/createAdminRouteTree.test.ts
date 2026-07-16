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
    expect(paths).toContain('/admin/ai/providers');
    expect(paths).toContain('/admin/ai/providers/:id');
  });

  it('deep links match nested paths and nested 404', () => {
    const routes = createAdminRouteTree();

    expect(matchRoutes(routes, '/admin')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/users')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/users/u-1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/ai/providers/p-1')).toBeTruthy();

    const nestedUnknown = matchRoutes(routes, '/admin/does-not-exist');
    expect(nestedUnknown).toBeTruthy();
    expect(nestedUnknown?.at(-1)?.route.path).toBe('*');
  });

  it('users routes are real pages; other modules remain placeholders', () => {
    const routes = createAdminRouteTree();
    const admin = routes.find((r) => r.path === '/admin');
    const children = admin?.children ?? [];

    const users = children.find((c) => c.path === 'users');
    const usersDetail = children.find((c) => c.path === 'users/:id');
    const settings = children.find((c) => c.path === 'settings');

    expect((users?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect((usersDetail?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      false,
    );
    expect((settings?.handle as { admin?: { placeholder?: boolean } })?.admin?.placeholder).toBe(
      true,
    );

    // Element is not the shared PlaceholderPage for users (lazy wrapper present)
    expect(users?.element).toBeTruthy();
    expect(usersDetail?.element).toBeTruthy();

    const placeholders = ADMIN_NAV_FLAT.filter((i) => i.placeholder);
    expect(placeholders.every((i) => i.id !== 'users' && i.id !== 'users-detail')).toBe(true);
  });
});

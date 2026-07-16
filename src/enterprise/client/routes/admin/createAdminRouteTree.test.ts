import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';

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
});

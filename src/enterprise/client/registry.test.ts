import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { createEnterpriseModuleRegistry, normalizeAdminExtensionRoute } from './registry';
import { createAdminRouteTree } from './routes/admin/createAdminRouteTree';

describe('enterpriseModuleRegistry', () => {
  it('starts empty so flag-off route trees stay unchanged', () => {
    const registry = createEnterpriseModuleRegistry();
    expect(registry.getRoutes()).toEqual([]);
  });

  it('normalizes absolute /admin paths to relative children and rejects duplicates', () => {
    const registry = createEnterpriseModuleRegistry();
    registry.register({
      id: 'admin-shell',
      routes: [
        {
          handle: { admin: { id: 'ext', requiredPermissions: [] } },
          path: '/admin/extensions/demo',
        },
      ],
    });
    expect(registry.getRoutes()).toEqual([
      {
        handle: { admin: { id: 'ext', requiredPermissions: [] } },
        path: 'extensions/demo',
      },
    ]);
    expect(() => registry.register({ id: 'admin-shell' })).toThrow(/already registered/);
  });

  it('rejects non-admin absolute paths and missing permission metadata', () => {
    expect(() => normalizeAdminExtensionRoute({ path: '/settings/leak', element: null })).toThrow(
      /under \/admin/,
    );
    expect(() => normalizeAdminExtensionRoute({ path: 'leak', element: null })).toThrow(
      /requiredPermissions/,
    );
  });

  it('rejects /administrator lookalike paths (exact /admin segment boundary)', () => {
    expect(() =>
      normalizeAdminExtensionRoute({
        handle: { admin: { id: 'bad', requiredPermissions: [] } },
        path: '/administrator/secret',
      }),
    ).toThrow(/under \/admin/);
    expect(() =>
      normalizeAdminExtensionRoute({
        handle: { admin: { id: 'bad', requiredPermissions: [] } },
        path: '/adminx',
      }),
    ).toThrow(/under \/admin/);
  });

  it('normalizes /admin/ and nested absolute paths without prefix bleed', () => {
    expect(
      normalizeAdminExtensionRoute({
        handle: { admin: { id: 'nested', requiredPermissions: ['x:read'] } },
        path: '/admin/extensions/foo',
      }).path,
    ).toBe('extensions/foo');
  });

  it('strips parent prefix from nested absolute children (no path double-prefix)', () => {
    // Regression: stripping `/admin` independently on each nested absolute path
    // mangled URLs: parent `extensions/foo` + child `extensions/foo/bar` →
    // full path `/admin/extensions/foo/extensions/foo/bar`.
    const normalized = normalizeAdminExtensionRoute({
      children: [
        {
          handle: { admin: { id: 'bar', requiredPermissions: ['ext:read'] } },
          path: '/admin/extensions/foo/bar',
        },
      ],
      handle: { admin: { id: 'foo', requiredPermissions: ['ext:read'] } },
      path: '/admin/extensions/foo',
    });
    expect(normalized.path).toBe('extensions/foo');
    expect(normalized.children?.[0]?.path).toBe('bar');
  });

  it('matchRoutes: nested absolute extension resolves under gated /admin (not mangled)', () => {
    const registry = createEnterpriseModuleRegistry();
    registry.register({
      id: 'nested-ext-match',
      routes: [
        {
          children: [
            {
              element: null,
              handle: { admin: { id: 'ext-bar', requiredPermissions: ['ext:read'] } },
              path: '/admin/extensions/foo/bar',
            },
          ],
          element: null,
          handle: { admin: { id: 'ext-foo', requiredPermissions: ['ext:read'] } },
          path: '/admin/extensions/foo',
        },
      ],
    });

    const extensionRoutes = registry.getRoutes();
    expect(extensionRoutes[0]?.path).toBe('extensions/foo');
    expect(extensionRoutes[0]?.children?.[0]?.path).toBe('bar');

    // Nest under the real gated tree (AdminRootGate parent), same as production.
    const tree = createAdminRouteTree(extensionRoutes);
    const matched = matchRoutes(tree, '/admin/extensions/foo/bar');
    expect(matched).toBeTruthy();
    // First match frame is the gated `/admin` shell — never a top-level sibling.
    expect(matched?.[0]?.route.path).toBe('/admin');
    // Leaf path is relative `bar`, not the double-prefixed mangled form.
    expect(matched?.at(-1)?.route.path).toBe('bar');
    expect(matched?.map((m) => m.route.path)).toEqual(['/admin', 'extensions/foo', 'bar']);

    // Mangled URL from the old independent /admin strip must not resolve to the leaf.
    const mangled = matchRoutes(tree, '/admin/extensions/foo/extensions/foo/bar');
    expect(mangled?.at(-1)?.route.path).not.toBe('bar');
  });

  it('recursively validates nested children require handle.admin.requiredPermissions', () => {
    expect(() =>
      normalizeAdminExtensionRoute({
        children: [{ path: 'leaf', element: null }],
        handle: { admin: { id: 'parent', requiredPermissions: ['system:read'] } },
        path: 'extensions/nested',
      }),
    ).toThrow(/requiredPermissions/);

    const normalized = normalizeAdminExtensionRoute({
      children: [
        {
          handle: { admin: { id: 'child', requiredPermissions: [] } },
          path: 'leaf',
        },
      ],
      handle: { admin: { id: 'parent', requiredPermissions: ['system:read'] } },
      path: 'extensions/nested',
    });
    expect(normalized.children?.[0]?.path).toBe('leaf');
  });
});

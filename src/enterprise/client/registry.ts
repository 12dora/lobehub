import type { RouteObject } from 'react-router';

/**
 * Enterprise module registration surface.
 * Modules expose admin child routes without patching core files.
 *
 * Routes are always nested under the gated `/admin` tree (AdminRootGate +
 * permission outlet). Absolute `/admin/...` paths are normalized to relative
 * children; non-admin paths are rejected at registration time.
 */
export interface EnterpriseModuleRegistration {
  id: string;
  /**
   * Child routes under `/admin`. Prefer relative paths (`extensions/foo`).
   * Absolute `/admin/...` is accepted and normalized. Each route must declare
   * `handle.admin.requiredPermissions` (array; may be empty for admin-access-only).
   */
  routes?: RouteObject[];
}

export interface EnterpriseAdminRouteHandle {
  admin: {
    id: string;
    placeholder?: boolean;
    requiredPermissions: readonly string[];
  };
}

export interface EnterpriseModuleRegistry {
  getRoutes: () => RouteObject[];
  register: (module: EnterpriseModuleRegistration) => void;
}

const isAdminHandle = (handle: unknown): handle is EnterpriseAdminRouteHandle => {
  if (!handle || typeof handle !== 'object') return false;
  const admin = (handle as { admin?: unknown }).admin;
  if (!admin || typeof admin !== 'object') return false;
  const required = (admin as { requiredPermissions?: unknown }).requiredPermissions;
  return Array.isArray(required);
};

/**
 * True only for exact `/admin` or `/admin/...` segment boundaries.
 * Rejects lookalikes like `/administrator` that share the `/admin` prefix.
 */
export const isExactAdminAbsolutePath = (path: string): boolean =>
  path === '/admin' || path.startsWith('/admin/');

/**
 * Strip leading `/admin` (exact segment) or a lone leading `/` to get a path relative
 * to the gated `/admin` parent. Empty string means the `/admin` index itself.
 */
const toAdminRelativePath = (path: string): string => {
  if (isExactAdminAbsolutePath(path)) {
    return path.replace(/^\/admin(?:\/|$)/, '');
  }
  return path.replace(/^\//, '');
};

/**
 * Normalize a registered module route into a relative `/admin` child.
 * Rejects absolute non-admin paths and missing permission metadata.
 * Recursively validates nested `children` so nested empty handles cannot slip past registration.
 *
 * Nested absolute children are made relative to their parent: a parent
 * `/admin/extensions/foo` with child `/admin/extensions/foo/bar` becomes
 * `extensions/foo` → child `bar` (not `extensions/foo/extensions/foo/bar`).
 *
 * @param parentRelativePath Relative path of the parent under `/admin` when recursing into children.
 */
export const normalizeAdminExtensionRoute = (
  route: RouteObject,
  parentRelativePath?: string,
): RouteObject => {
  const path = route.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('Enterprise module admin routes must declare a non-empty path');
  }
  if (path.startsWith('/') && !isExactAdminAbsolutePath(path)) {
    throw new Error(`Enterprise module routes must live under /admin (got absolute path: ${path})`);
  }
  if (!isAdminHandle(route.handle)) {
    throw new Error(
      `Enterprise module route "${path}" must set handle.admin.requiredPermissions (use [] for access-only)`,
    );
  }

  // First: absolute `/admin/...` → relative under `/admin`.
  let relative: string | undefined = toAdminRelativePath(path) || undefined;

  // Nested: strip parent prefix so absolute children stay correct under RR nesting.
  // Parent `extensions/foo` + child `/admin/extensions/foo/bar` → `bar`.
  if (parentRelativePath && relative) {
    if (relative === parentRelativePath) {
      throw new Error(
        `Enterprise module nested route "${path}" cannot reuse its parent path under /admin`,
      );
    }
    const parentPrefix = `${parentRelativePath}/`;
    if (relative.startsWith(parentPrefix)) {
      relative = relative.slice(parentPrefix.length) || undefined;
    } else if (isExactAdminAbsolutePath(path)) {
      // Absolute child that is not under this parent would mangle the URL tree.
      throw new Error(
        `Enterprise module nested absolute route "${path}" must be under parent "/admin/${parentRelativePath}"`,
      );
    }
  }

  if (!relative) {
    throw new Error('Enterprise module routes cannot replace the /admin index; use a child path');
  }

  // Non-index child routes only (extension modules always declare a path).
  const children = route.children?.map((child) => normalizeAdminExtensionRoute(child, relative));

  const normalized: RouteObject = {
    ...route,
    path: relative,
  };

  if (children && children.length > 0) {
    // Explicit assignment keeps the NonIndexRouteObject branch (children + path).
    (normalized as { children?: RouteObject[] }).children = children;
  }

  return normalized;
};

export const createEnterpriseModuleRegistry = (): EnterpriseModuleRegistry => {
  const modules: EnterpriseModuleRegistration[] = [];

  return {
    getRoutes: () =>
      modules.flatMap((module) =>
        (module.routes ?? []).map((route) => normalizeAdminExtensionRoute(route)),
      ),
    register: (module) => {
      if (modules.some((existing) => existing.id === module.id)) {
        throw new Error(`Enterprise module already registered: ${module.id}`);
      }
      // Validate eagerly so bad modules fail at registration, not at first navigation.
      for (const route of module.routes ?? []) {
        normalizeAdminExtensionRoute(route);
      }
      modules.push(module);
    },
  };
};

/** Process-wide registry for client module plugins. */
export const enterpriseModuleRegistry = createEnterpriseModuleRegistry();

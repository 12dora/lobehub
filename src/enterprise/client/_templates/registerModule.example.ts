/**
 * Example: register an enterprise module (do not import this file in production).
 * See docs/enterprise-patches/module-template.md for the full checklist.
 *
 * @example
 * ```ts
 * import { enterpriseModuleRegistry } from '@/enterprise/client';
 * import type { RouteObject } from 'react-router';
 *
 * const routes: RouteObject[] = [
 *   // { path: '/admin', lazy: () => import('../features/AdminShell') },
 * ];
 *
 * enterpriseModuleRegistry.register({
 *   id: 'admin-shell',
 *   routes,
 *   menuItems: [{ id: 'overview', labelKey: 'admin.menu.overview', path: '/admin' }],
 * });
 * ```
 */

export const ENTERPRISE_MODULE_TEMPLATE_DOC = 'docs/enterprise-patches/module-template.md';

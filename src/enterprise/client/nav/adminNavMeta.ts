import { matchPath } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

/** i18n keys used by the admin nav catalog (`admin` namespace). */
export type AdminNavLabelKey =
  | 'nav.overview'
  | 'nav.stats'
  | 'nav.users'
  | 'nav.userDetail'
  | 'nav.reauthComplete'
  | 'nav.settings'
  | 'nav.managedResources'
  | 'nav.ai'
  | 'nav.aiProviders'
  | 'nav.aiProviderDetail'
  | 'nav.aiModels'
  | 'nav.aiCreds'
  | 'nav.skills'
  | 'nav.skillDetail'
  | 'nav.connectors'
  | 'nav.connectorDetail'
  | 'nav.agents'
  | 'nav.agentDetail'
  | 'nav.identity'
  | 'nav.branding'
  | 'nav.audit'
  | 'nav.system';

/**
 * Single source of truth for admin nav + route permission declarations.
 * Menu visibility and route guards must both read from this catalog so they cannot drift.
 */
export interface AdminNavItem {
  /** Nested items (e.g. AI providers / models). */
  children?: AdminNavItem[];
  /** Hide from side nav while still registering a route (detail pages). */
  hideFromNav?: boolean;
  id: string;
  /** i18n key under the `admin` namespace. */
  labelKey: AdminNavLabelKey;
  /**
   * Absolute path pattern under `/admin` (e.g. `/admin/users` or `/admin/users/:id`).
   * Use React Router path patterns; matching uses `matchPath` (most specific wins).
   */
  path: string;
  /**
   * Placeholder for modules not yet implemented (M04+).
   * Still registered so deep links resolve to a deliberate "coming soon" surface.
   */
  placeholder?: boolean;
  /**
   * Permissions required to show the item / enter the route.
   * Empty array means only shell access (`platform_admin:access:all`) is required.
   * User must have **all** listed permissions.
   */
  requiredPermissions: readonly string[];
}

/** Planned admin IA — keep in sync with docs/redevelopment/list/03_前端路由与页面清单.md */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  {
    id: 'overview',
    labelKey: 'nav.overview',
    path: '/admin',
    requiredPermissions: [],
  },
  {
    id: 'stats',
    labelKey: 'nav.stats',
    path: '/admin/stats',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.STATS_READ],
  },
  {
    id: 'users',
    labelKey: 'nav.users',
    path: '/admin/users',
    // M04: real list page
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.USER_READ],
  },
  {
    hideFromNav: true,
    id: 'users-detail',
    labelKey: 'nav.userDetail',
    path: '/admin/users/:id',
    // M04: real detail page
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.USER_READ],
  },
  {
    hideFromNav: true,
    id: 'reauth-complete',
    labelKey: 'nav.reauthComplete',
    path: '/admin/reauth-complete',
    // Popup landing after Better Auth reauth — no extra permission
    placeholder: false,
    requiredPermissions: [],
  },
  {
    id: 'settings',
    labelKey: 'nav.settings',
    path: '/admin/settings',
    // M05: production settings policy page
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.SETTINGS_READ],
  },
  {
    id: 'managed-resources',
    labelKey: 'nav.managedResources',
    path: '/admin/managed-resources',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.POLICY_READ],
  },
  {
    children: [
      {
        id: 'ai-providers',
        labelKey: 'nav.aiProviders',
        path: '/admin/ai/providers',
        placeholder: false,
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      },
      {
        hideFromNav: true,
        id: 'ai-provider-detail',
        labelKey: 'nav.aiProviderDetail',
        path: '/admin/ai/providers/:id',
        placeholder: false,
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      },
      {
        id: 'ai-models',
        labelKey: 'nav.aiModels',
        path: '/admin/ai/models',
        placeholder: false,
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_MODEL_READ],
      },
      {
        id: 'ai-creds',
        labelKey: 'nav.aiCreds',
        path: '/admin/ai/creds',
        placeholder: false,
        requiredPermissions: [PLATFORM_PERMISSIONS.CRED_READ],
      },
    ],
    id: 'ai',
    labelKey: 'nav.ai',
    path: '/admin/ai',
    placeholder: true,
    requiredPermissions: [],
  },
  {
    id: 'skills',
    labelKey: 'nav.skills',
    path: '/admin/skills',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
  },
  {
    hideFromNav: true,
    id: 'skills-detail',
    labelKey: 'nav.skillDetail',
    path: '/admin/skills/:id',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
  },
  {
    id: 'connectors',
    labelKey: 'nav.connectors',
    path: '/admin/connectors',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
  },
  {
    hideFromNav: true,
    id: 'connectors-detail',
    labelKey: 'nav.connectorDetail',
    path: '/admin/connectors/:id',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
  },
  {
    id: 'agents',
    labelKey: 'nav.agents',
    path: '/admin/agents',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.AGENT_READ],
  },
  {
    hideFromNav: true,
    id: 'agents-detail',
    labelKey: 'nav.agentDetail',
    path: '/admin/agents/:id',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.AGENT_READ],
  },
  {
    id: 'identity-providers',
    labelKey: 'nav.identity',
    path: '/admin/identity-providers',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.IDENTITY_READ],
  },
  {
    id: 'branding',
    labelKey: 'nav.branding',
    path: '/admin/branding',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.BRANDING_READ],
  },
  {
    id: 'audit',
    labelKey: 'nav.audit',
    path: '/admin/audit',
    placeholder: true,
    requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_READ],
  },
  {
    id: 'system',
    labelKey: 'nav.system',
    path: '/admin/system',
    placeholder: false,
    requiredPermissions: [PLATFORM_PERMISSIONS.SYSTEM_READ],
  },
] as const;

const flattenNav = (items: readonly AdminNavItem[]): AdminNavItem[] => {
  const out: AdminNavItem[] = [];
  for (const item of items) {
    out.push(item);
    if (item.children?.length) out.push(...flattenNav(item.children));
  }
  return out;
};

/** Flat catalog of every registered admin path (including nested + hidden details). */
export const ADMIN_NAV_FLAT: readonly AdminNavItem[] = flattenNav(ADMIN_NAV_ITEMS);

/** Specificity score: more segments + static (non-param) segments rank higher. */
const pathSpecificity = (pattern: string): number => {
  const parts = pattern.split('/').filter(Boolean);
  let score = parts.length * 100;
  for (const part of parts) {
    if (!part.startsWith(':')) score += 10;
  }
  return score;
};

/**
 * Resolve the catalog entry for a pathname using React Router `matchPath`.
 * Most-specific pattern wins (static beats param; longer beats shorter).
 * Never uses unsafe string-prefix matching alone.
 */
export const findAdminNavItemByPath = (pathname: string): AdminNavItem | undefined => {
  const normalized = pathname.replace(/\/+$/, '') || '/admin';

  const matches = ADMIN_NAV_FLAT.filter((item) =>
    Boolean(matchPath({ end: true, path: item.path }, normalized)),
  );

  if (matches.length === 0) return undefined;

  matches.sort((a, b) => pathSpecificity(b.path) - pathSpecificity(a.path));
  return matches[0];
};

export const hasAllPermissions = (
  granted: readonly string[],
  required: readonly string[],
): boolean => {
  if (required.length === 0) return true;
  const set = new Set(granted);
  return required.every((p) => set.has(p));
};

/**
 * Filter nav tree by granted permissions.
 * Parent groups without a direct permission stay when any child is visible.
 * Hidden detail routes are never shown in the menu.
 */
export const filterAdminNavByPermissions = (
  items: readonly AdminNavItem[],
  granted: readonly string[],
): AdminNavItem[] => {
  const result: AdminNavItem[] = [];

  for (const item of items) {
    if (item.hideFromNav) continue;

    const children = item.children
      ? filterAdminNavByPermissions(item.children, granted)
      : undefined;

    const selfAllowed = hasAllPermissions(granted, item.requiredPermissions);
    const hasVisibleChildren = Boolean(children && children.length > 0);

    if (item.children?.length) {
      if (hasVisibleChildren) {
        result.push({ ...item, children });
      } else if (selfAllowed && item.requiredPermissions.length > 0) {
        result.push({ ...item, children: [] });
      }
      continue;
    }

    if (selfAllowed) {
      result.push(item);
    }
  }

  return result;
};

/** Whether the current principal may open this path (shell access assumed separately). */
export const canAccessAdminPath = (pathname: string, granted: readonly string[]): boolean => {
  const item = findAdminNavItemByPath(pathname);
  if (!item) return false;
  return hasAllPermissions(granted, item.requiredPermissions);
};

/** Breadcrumb chain from overview to the current path (exact + ancestor patterns). */
export const getAdminBreadcrumbs = (pathname: string): AdminNavItem[] => {
  const normalized = pathname.replace(/\/+$/, '') || '/admin';
  const crumbs: AdminNavItem[] = [];

  const overview = ADMIN_NAV_FLAT.find((i) => i.id === 'overview');
  if (overview) crumbs.push(overview);

  if (normalized === '/admin') return crumbs;

  // Ancestors: patterns that match as prefix (end:false) excluding pure overview
  const ancestors = ADMIN_NAV_FLAT.filter((item) => {
    if (item.path === '/admin') return false;
    // Skip detail-only crumbs that match the full path; add them once at end via exact match
    if (item.path.includes(':')) {
      return Boolean(matchPath({ end: true, path: item.path }, normalized));
    }
    return Boolean(matchPath({ end: false, path: item.path }, normalized));
  }).sort((a, b) => pathSpecificity(a.path) - pathSpecificity(b.path));

  for (const match of ancestors) {
    if (!crumbs.some((c) => c.id === match.id)) crumbs.push(match);
  }

  return crumbs;
};

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
  | 'nav.unifiedManagement'
  | 'nav.ai'
  | 'nav.aiProviders'
  | 'nav.aiProviderDetail'
  | 'nav.aiServiceModel'
  | 'nav.aiMemory'
  | 'nav.aiCatalogProviders'
  | 'nav.aiCatalogProviderDetail'
  | 'nav.aiCatalogModels'
  | 'nav.aiSkills'
  | 'nav.aiSkillDetail'
  | 'nav.aiConnectors'
  | 'nav.aiConnectorDetail'
  | 'nav.skills'
  | 'nav.skillDetail'
  | 'nav.connectors'
  | 'nav.connectorDetail'
  | 'nav.agents'
  | 'nav.agentDetail'
  | 'nav.identity'
  | 'nav.securityAuth'
  | 'nav.branding'
  | 'nav.audit'
  | 'nav.auditLogs'
  | 'nav.auditLive'
  | 'nav.auditConversations'
  | 'nav.auditConversationUser'
  | 'nav.auditConversationTopic'
  | 'nav.auditExports'
  | 'nav.auditLegalHolds'
  | 'nav.auditRetention'
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
   * Permissions required to show the item / enter the route.
   * Empty array means only shell access (`platform_admin:access:all`) is required.
   * User must have **all** listed permissions.
   */
  requiredPermissions: readonly string[];
}

/** Admin IA — keep in sync with docs/enterprise/reference/admin-routes.md */
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
    requiredPermissions: [PLATFORM_PERMISSIONS.STATS_READ],
  },
  {
    id: 'users',
    labelKey: 'nav.users',
    path: '/admin/users',
    // M04: real list page
    requiredPermissions: [PLATFORM_PERMISSIONS.USER_READ],
  },
  {
    hideFromNav: true,
    id: 'users-detail',
    labelKey: 'nav.userDetail',
    path: '/admin/users/:id',
    // M04: real detail page
    requiredPermissions: [PLATFORM_PERMISSIONS.USER_READ],
  },
  {
    hideFromNav: true,
    id: 'reauth-complete',
    labelKey: 'nav.reauthComplete',
    path: '/admin/reauth-complete',
    // Popup landing after Better Auth reauth — no extra permission
    requiredPermissions: [],
  },
  {
    // Merged surface hosting both the settings-policy and managed-resources tabs.
    // Shell-only gate here; each in-page tab self-gates on SETTINGS_READ / POLICY_READ.
    id: 'unified-management',
    labelKey: 'nav.unifiedManagement',
    path: '/admin/unified',
    requiredPermissions: [],
  },
  {
    // Kept registered (hidden) for deep-link back-compat; the visible surface is `unified-management`.
    hideFromNav: true,
    id: 'settings',
    labelKey: 'nav.settings',
    // M05: production settings policy page
    path: '/admin/settings',
    requiredPermissions: [PLATFORM_PERMISSIONS.SETTINGS_READ],
  },
  {
    // Kept registered (hidden) for deep-link back-compat; the visible surface is `unified-management`.
    // Shell requires POLICY_READ for this deep link; connector-only admins use the unified tab
    // (which OR-gates POLICY_READ | CONNECTOR_READ and self-gates the page body).
    hideFromNav: true,
    id: 'managed-resources',
    labelKey: 'nav.managedResources',
    path: '/admin/managed-resources',
    requiredPermissions: [PLATFORM_PERMISSIONS.POLICY_READ],
  },
  {
    children: [
      {
        id: 'ai-providers',
        labelKey: 'nav.aiProviders',
        path: '/admin/ai/providers',
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      },
      {
        hideFromNav: true,
        id: 'ai-provider-detail',
        labelKey: 'nav.aiProviderDetail',
        path: '/admin/ai/providers/:id',
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      },
      {
        id: 'ai-service-model',
        labelKey: 'nav.aiServiceModel',
        path: '/admin/ai/service-model',
        requiredPermissions: [PLATFORM_PERMISSIONS.SETTINGS_READ],
      },
      {
        id: 'ai-skills',
        labelKey: 'nav.aiSkills',
        path: '/admin/ai/skills',
        requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
      },
      {
        hideFromNav: true,
        id: 'ai-skill-detail',
        labelKey: 'nav.aiSkillDetail',
        path: '/admin/ai/skills/:id',
        requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
      },
      {
        id: 'ai-connectors',
        labelKey: 'nav.aiConnectors',
        path: '/admin/ai/connectors',
        requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
      },
      {
        hideFromNav: true,
        id: 'ai-connector-detail',
        labelKey: 'nav.aiConnectorDetail',
        path: '/admin/ai/connectors/:id',
        requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
      },
      {
        id: 'ai-memory',
        labelKey: 'nav.aiMemory',
        path: '/admin/ai/memory',
        requiredPermissions: [PLATFORM_PERMISSIONS.SETTINGS_READ],
      },
      // Advanced draft/publish/revision catalog (former self-built pages) — hidden from nav
      {
        hideFromNav: true,
        id: 'ai-catalog-providers',
        labelKey: 'nav.aiCatalogProviders',
        path: '/admin/ai/catalog/providers',
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      },
      {
        hideFromNav: true,
        id: 'ai-catalog-provider-detail',
        labelKey: 'nav.aiCatalogProviderDetail',
        path: '/admin/ai/catalog/providers/:id',
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      },
      {
        hideFromNav: true,
        id: 'ai-catalog-models',
        labelKey: 'nav.aiCatalogModels',
        path: '/admin/ai/catalog/models',
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_MODEL_READ],
      },
    ],
    id: 'ai',
    labelKey: 'nav.ai',
    path: '/admin/ai',
    requiredPermissions: [],
  },
  // Advanced catalog (former top-level) — routes kept, hidden from nav
  {
    hideFromNav: true,
    id: 'skills',
    labelKey: 'nav.skills',
    path: '/admin/skills',
    requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
  },
  {
    hideFromNav: true,
    id: 'skills-detail',
    labelKey: 'nav.skillDetail',
    path: '/admin/skills/:id',
    requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
  },
  {
    hideFromNav: true,
    id: 'connectors',
    labelKey: 'nav.connectors',
    path: '/admin/connectors',
    requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
  },
  {
    hideFromNav: true,
    id: 'connectors-detail',
    labelKey: 'nav.connectorDetail',
    path: '/admin/connectors/:id',
    requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
  },
  {
    id: 'agents',
    labelKey: 'nav.agents',
    path: '/admin/agents',
    requiredPermissions: [PLATFORM_PERMISSIONS.AGENT_READ],
  },
  {
    hideFromNav: true,
    id: 'agents-detail',
    labelKey: 'nav.agentDetail',
    path: '/admin/agents/:id',
    requiredPermissions: [PLATFORM_PERMISSIONS.AGENT_READ],
  },
  {
    // "安全与认证" surface: hosts the identity-provider ("登录方式") tab and the
    // registration/login policy ("通用设置") tab. Path kept for deep-link back-compat.
    id: 'identity-providers',
    labelKey: 'nav.securityAuth',
    path: '/admin/identity-providers',
    requiredPermissions: [PLATFORM_PERMISSIONS.IDENTITY_READ],
  },
  {
    id: 'branding',
    labelKey: 'nav.branding',
    path: '/admin/branding',
    requiredPermissions: [PLATFORM_PERMISSIONS.BRANDING_READ],
  },
  {
    children: [
      {
        id: 'audit-logs',
        labelKey: 'nav.auditLogs',
        path: '/admin/audit/logs',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_READ],
      },
      {
        id: 'audit-live',
        labelKey: 'nav.auditLive',
        path: '/admin/audit/live',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ],
      },
      {
        id: 'audit-conversations',
        labelKey: 'nav.auditConversations',
        path: '/admin/audit/conversations',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ],
      },
      {
        hideFromNav: true,
        id: 'audit-conversation-user',
        labelKey: 'nav.auditConversationUser',
        path: '/admin/audit/conversations/:userId',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ],
      },
      {
        hideFromNav: true,
        id: 'audit-conversation-topic',
        labelKey: 'nav.auditConversationTopic',
        path: '/admin/audit/conversations/:userId/topics/:topicId',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ],
      },
      {
        id: 'audit-exports',
        labelKey: 'nav.auditExports',
        path: '/admin/audit/exports',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_EXPORT],
      },
      {
        id: 'audit-legal-holds',
        labelKey: 'nav.auditLegalHolds',
        path: '/admin/audit/holds',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE],
      },
      {
        id: 'audit-retention',
        labelKey: 'nav.auditRetention',
        path: '/admin/audit/retention',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE],
      },
    ],
    id: 'audit',
    labelKey: 'nav.audit',
    path: '/admin/audit',
    // Group shell: visible when any child is allowed (same as `ai` group).
    requiredPermissions: [],
  },
  {
    id: 'system',
    labelKey: 'nav.system',
    path: '/admin/system',
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

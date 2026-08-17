import { matchPath } from 'react-router';

import type { PlatformModuleId } from '@/const/platform/modules';
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
  | 'nav.aiSkills'
  | 'nav.aiSkillDetail'
  | 'nav.aiConnectors'
  | 'nav.aiConnectorDetail'
  | 'nav.skills'
  | 'nav.skillDetail'
  | 'nav.connectors'
  | 'nav.connectorDetail'
  | 'nav.agents'
  | 'nav.identity'
  | 'nav.securityAuth'
  | 'nav.branding'
  | 'nav.audit'
  | 'nav.auditLogs'
  | 'nav.auditLive'
  | 'nav.auditConversations'
  | 'nav.contentModeration'
  | 'nav.auditConversationUser'
  | 'nav.auditConversationTopic'
  | 'nav.auditExports'
  | 'nav.auditLegalHolds'
  | 'nav.auditRetention'
  | 'nav.system'
  | 'nav.systemGeneral'
  | 'nav.systemStatus'
  | 'nav.modules'
  | 'nav.taskTemplates';

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
  /**
   * Group only: child `id` the group index route should prefer, instead of the first visible
   * child. Used when the group path is a legacy deep link whose historical destination is not
   * first in the menu (e.g. `/admin/system` used to be the status page). Falls back to the
   * first visible + authorized child when that child is hidden or not permitted.
   */
  indexRedirectTo?: string;
  /** i18n key under the `admin` namespace. */
  labelKey: AdminNavLabelKey;
  /**
   * Optional platform module owning this surface. When the module is disabled the item is
   * hidden from the side nav and a direct link renders `AdminModuleDisabledSurface` instead of
   * a 404 — the route stays registered so the reason is always explainable.
   * Core admin surfaces (overview / users / system / security & auth) carry no module id.
   */
  moduleId?: PlatformModuleId;
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
    moduleId: 'platformStats',
    path: '/admin/stats',
    requiredPermissions: [PLATFORM_PERMISSIONS.STATS_READ],
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
    children: [
      {
        id: 'ai-providers',
        labelKey: 'nav.aiProviders',
        moduleId: 'managedAi',
        path: '/admin/ai/providers',
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      },
      {
        hideFromNav: true,
        id: 'ai-provider-detail',
        labelKey: 'nav.aiProviderDetail',
        moduleId: 'managedAi',
        path: '/admin/ai/providers/:id',
        requiredPermissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      },
      {
        id: 'ai-service-model',
        labelKey: 'nav.aiServiceModel',
        moduleId: 'managedAi',
        path: '/admin/ai/service-model',
        requiredPermissions: [PLATFORM_PERMISSIONS.SETTINGS_READ],
      },
      {
        id: 'ai-skills',
        labelKey: 'nav.aiSkills',
        moduleId: 'managedSkills',
        path: '/admin/ai/skills',
        requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
      },
      {
        hideFromNav: true,
        id: 'ai-skill-detail',
        labelKey: 'nav.aiSkillDetail',
        moduleId: 'managedSkills',
        path: '/admin/ai/skills/:id',
        requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
      },
      {
        id: 'ai-connectors',
        labelKey: 'nav.aiConnectors',
        moduleId: 'managedConnectors',
        path: '/admin/ai/connectors',
        requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
      },
      {
        hideFromNav: true,
        id: 'ai-connector-detail',
        labelKey: 'nav.aiConnectorDetail',
        moduleId: 'managedConnectors',
        path: '/admin/ai/connectors/:id',
        requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
      },
      {
        id: 'ai-memory',
        labelKey: 'nav.aiMemory',
        moduleId: 'memory',
        path: '/admin/ai/memory',
        requiredPermissions: [PLATFORM_PERMISSIONS.SETTINGS_READ],
      },
      {
        // 任务模板 — authored recommendations that create a scheduled task on the inbox agent,
        // so they reuse the platform-agent permission codes (no extra RBAC seeding).
        id: 'task-templates',
        labelKey: 'nav.taskTemplates',
        moduleId: 'taskTemplates',
        path: '/admin/ai/task-templates',
        requiredPermissions: [PLATFORM_PERMISSIONS.AGENT_READ],
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
    moduleId: 'managedSkills',
    path: '/admin/skills',
    requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
  },
  {
    hideFromNav: true,
    id: 'skills-detail',
    labelKey: 'nav.skillDetail',
    moduleId: 'managedSkills',
    path: '/admin/skills/:id',
    requiredPermissions: [PLATFORM_PERMISSIONS.SKILL_READ],
  },
  {
    hideFromNav: true,
    id: 'connectors',
    labelKey: 'nav.connectors',
    moduleId: 'managedConnectors',
    path: '/admin/connectors',
    requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
  },
  {
    hideFromNav: true,
    id: 'connectors-detail',
    labelKey: 'nav.connectorDetail',
    moduleId: 'managedConnectors',
    path: '/admin/connectors/:id',
    requiredPermissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ],
  },
  {
    id: 'agents',
    labelKey: 'nav.agents',
    moduleId: 'managedAgents',
    path: '/admin/agents',
    requiredPermissions: [PLATFORM_PERMISSIONS.AGENT_READ],
  },
  {
    children: [
      {
        id: 'audit-logs',
        labelKey: 'nav.auditLogs',
        moduleId: 'audit',
        path: '/admin/audit/logs',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_READ],
      },
      {
        id: 'audit-live',
        labelKey: 'nav.auditLive',
        moduleId: 'audit',
        path: '/admin/audit/live',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ],
      },
      {
        id: 'audit-conversations',
        labelKey: 'nav.auditConversations',
        moduleId: 'audit',
        path: '/admin/audit/conversations',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ],
      },
      {
        hideFromNav: true,
        id: 'audit-conversation-user',
        labelKey: 'nav.auditConversationUser',
        moduleId: 'audit',
        path: '/admin/audit/conversations/:userId',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ],
      },
      {
        hideFromNav: true,
        id: 'audit-conversation-topic',
        labelKey: 'nav.auditConversationTopic',
        moduleId: 'audit',
        path: '/admin/audit/conversations/:userId/topics/:topicId',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ],
      },
      {
        id: 'content-moderation',
        labelKey: 'nav.contentModeration',
        moduleId: 'moderation',
        path: '/admin/audit/content-moderation',
        requiredPermissions: [PLATFORM_PERMISSIONS.MODERATION_READ],
      },
      {
        id: 'audit-exports',
        labelKey: 'nav.auditExports',
        moduleId: 'audit',
        path: '/admin/audit/exports',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_EXPORT],
      },
      {
        id: 'audit-legal-holds',
        labelKey: 'nav.auditLegalHolds',
        moduleId: 'audit',
        path: '/admin/audit/holds',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE],
      },
      {
        id: 'audit-retention',
        labelKey: 'nav.auditRetention',
        moduleId: 'audit',
        path: '/admin/audit/retention',
        requiredPermissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE],
      },
    ],
    id: 'audit',
    labelKey: 'nav.audit',
    // No `moduleId` on the group itself: 内容审计 is its own module, so the group must stay
    // visible while any child is. The group disappears automatically once every child is gone.
    path: '/admin/audit',
    // Group shell: visible when any child is allowed (same as `ai` group).
    requiredPermissions: [],
  },
  {
    children: [
      {
        id: 'system-general',
        labelKey: 'nav.systemGeneral',
        path: '/admin/system/general',
        requiredPermissions: [PLATFORM_PERMISSIONS.SYSTEM_READ],
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
        moduleId: 'settingsPolicy',
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
        moduleId: 'managedAi',
        path: '/admin/managed-resources',
        requiredPermissions: [PLATFORM_PERMISSIONS.POLICY_READ],
      },
      {
        // 模块 — deployment-level on/off switches. Core surface (it is how a disabled module
        // gets turned back on), so it never carries a `moduleId` of its own.
        id: 'modules',
        labelKey: 'nav.modules',
        path: '/admin/system/modules',
        requiredPermissions: [PLATFORM_PERMISSIONS.SYSTEM_READ],
      },
      {
        // Former `/admin/system` leaf. `/admin/system` is now the group index redirect
        // (pinned back to this child), so old deep links still land on a real page.
        id: 'system-status',
        labelKey: 'nav.systemStatus',
        path: '/admin/system/status',
        requiredPermissions: [PLATFORM_PERMISSIONS.SYSTEM_READ],
      },
      {
        // "安全与认证" surface: hosts the identity-provider ("登录方式") tab and the
        // registration/login policy ("通用设置") tab. Path kept for deep-link back-compat.
        id: 'identity-providers',
        labelKey: 'nav.securityAuth',
        // Core surface: the 通用设置 tab is registration/login policy, which no module owns.
        // Only the 登录方式 tab is gated on `databaseIdp` (in-page, like the network-proxy tab).
        path: '/admin/identity-providers',
        requiredPermissions: [PLATFORM_PERMISSIONS.IDENTITY_READ],
      },
      {
        id: 'branding',
        labelKey: 'nav.branding',
        moduleId: 'branding',
        path: '/admin/branding',
        requiredPermissions: [PLATFORM_PERMISSIONS.BRANDING_READ],
      },
    ],
    id: 'system',
    // `/admin/system` was the status page before the group existed, so keep old bookmarks
    // landing there rather than on the (first-in-menu) empty general-settings placeholder.
    indexRedirectTo: 'system-status',
    labelKey: 'nav.system',
    // Group children keep their historical absolute paths (`/admin/users`, `/admin/branding`, …):
    // routing derives every leaf from its own `path`, so no redirect churn is needed.
    path: '/admin/system',
    // Group shell: visible when any child is allowed (same as `ai` / `audit`).
    requiredPermissions: [],
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

/**
 * Group ancestry by id. Group children are not required to live under the group path
 * (e.g. `users` sits at `/admin/users` inside the `system` group), so breadcrumbs read
 * ancestry from the tree instead of relying on path prefixes alone.
 */
const buildNavParentById = (): ReadonlyMap<string, AdminNavItem> => {
  const map = new Map<string, AdminNavItem>();
  const walk = (items: readonly AdminNavItem[], parent?: AdminNavItem) => {
    for (const item of items) {
      if (parent) map.set(item.id, parent);
      if (item.children?.length) walk(item.children, item);
    }
  };
  walk(ADMIN_NAV_ITEMS);
  return map;
};

const ADMIN_NAV_PARENT_BY_ID = buildNavParentById();

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

const NO_DISABLED_MODULES: ReadonlySet<PlatformModuleId> = new Set<PlatformModuleId>();

/** Whether this catalog entry belongs to a module the deployment has switched off. */
export const isAdminNavItemModuleDisabled = (
  item: AdminNavItem | undefined,
  disabledModules: ReadonlySet<PlatformModuleId> = NO_DISABLED_MODULES,
): boolean => Boolean(item?.moduleId && disabledModules.has(item.moduleId));

/** Module owning the surface behind a path, if any. */
export const findAdminNavModuleId = (pathname: string): PlatformModuleId | undefined =>
  findAdminNavItemByPath(pathname)?.moduleId;

/**
 * Filter nav tree by granted permissions.
 * Parent groups without a direct permission stay when any child is visible.
 * Hidden detail routes are never shown in the menu.
 *
 * `disabledModules` additionally drops surfaces whose module is switched off for this
 * deployment. Defaults to empty, so every existing caller keeps today's behaviour.
 */
export const filterAdminNavByPermissions = (
  items: readonly AdminNavItem[],
  granted: readonly string[],
  disabledModules: ReadonlySet<PlatformModuleId> = NO_DISABLED_MODULES,
): AdminNavItem[] => {
  const result: AdminNavItem[] = [];

  for (const item of items) {
    if (item.hideFromNav) continue;
    if (isAdminNavItemModuleDisabled(item, disabledModules)) continue;

    const children = item.children
      ? filterAdminNavByPermissions(item.children, granted, disabledModules)
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

  // Push tree ancestors (nav groups) before the item itself so a group crumb appears even
  // when the child keeps a path outside the group prefix (e.g. `system` → `/admin/users`).
  const pushWithAncestors = (item: AdminNavItem) => {
    const parent = ADMIN_NAV_PARENT_BY_ID.get(item.id);
    if (parent) pushWithAncestors(parent);
    if (!crumbs.some((c) => c.id === item.id)) crumbs.push(item);
  };

  for (const match of ancestors) pushWithAncestors(match);

  return crumbs;
};

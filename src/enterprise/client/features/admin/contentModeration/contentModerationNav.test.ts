import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { ADMIN_NAV_ICONS } from '@/enterprise/client/nav/adminIcons';
import { ADMIN_NAV_FLAT, ADMIN_NAV_ITEMS } from '@/enterprise/client/nav/adminNavMeta';
import { getAdminPageComponentId } from '@/enterprise/client/nav/adminPageCatalog';
import { createAdminRouteTree } from '@/enterprise/client/routes/admin/createAdminRouteTree';

const NAV_ID = 'content-moderation';

describe('content moderation nav registration', () => {
  it('is a child of the 审计 group, right after 会话历史', () => {
    const audit = ADMIN_NAV_ITEMS.find((item) => item.id === 'audit');
    const visible = (audit?.children ?? []).filter((child) => !child.hideFromNav);
    const ids = visible.map((child) => child.id);
    expect(ids).toContain(NAV_ID);
    expect(ids.indexOf(NAV_ID)).toBe(ids.indexOf('audit-conversations') + 1);
  });

  it('declares the moderation read permission and its own path', () => {
    const item = ADMIN_NAV_FLAT.find((entry) => entry.id === NAV_ID);
    expect(item).toBeDefined();
    expect(item?.path).toBe('/admin/audit/content-moderation');
    expect(item?.labelKey).toBe('nav.contentModeration');
    expect(item?.requiredPermissions).toEqual([PLATFORM_PERMISSIONS.MODERATION_READ]);
  });

  it('has an icon and a real page component (never the 404 fallback)', () => {
    expect(ADMIN_NAV_ICONS[NAV_ID]).toBeDefined();
    expect(getAdminPageComponentId(NAV_ID)).toBe('ContentModerationPage');
  });

  it('is reachable through the shared admin route tree with its permission attached', () => {
    const tree = createAdminRouteTree();
    const adminRoot = tree.find((route) => route.path === '/admin');
    const leaf = (adminRoot?.children ?? []).find(
      (route) => route.path === 'audit/content-moderation',
    );
    expect(leaf).toBeDefined();
    expect(
      (leaf?.handle as { admin?: { requiredPermissions?: readonly string[] } })?.admin
        ?.requiredPermissions,
    ).toEqual([PLATFORM_PERMISSIONS.MODERATION_READ]);
  });
});

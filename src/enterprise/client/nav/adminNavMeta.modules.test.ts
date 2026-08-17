import { describe, expect, it } from 'vitest';

import { PLATFORM_MODULE_IDS, type PlatformModuleId } from '@/const/platform/modules';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import {
  ADMIN_NAV_FLAT,
  ADMIN_NAV_ITEMS,
  filterAdminNavByPermissions,
  findAdminNavItemByPath,
  findAdminNavModuleId,
  isAdminNavItemModuleDisabled,
} from './adminNavMeta';

const ALL_PERMISSIONS = Object.values(PLATFORM_PERMISSIONS);

const flatten = (items: ReturnType<typeof filterAdminNavByPermissions>): string[] =>
  items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);

describe('admin nav module annotations', () => {
  it('only ever references ids that exist in the module table', () => {
    for (const item of ADMIN_NAV_FLAT) {
      if (!item.moduleId) continue;
      expect(PLATFORM_MODULE_IDS).toContain(item.moduleId);
    }
  });

  it('leaves the surfaces an operator needs to recover with unannotated', () => {
    // Turning a module back on must never require the module that was turned off.
    for (const id of ['overview', 'users', 'system-status', 'system-general', 'modules']) {
      expect(findAdminNavItemByPath(ADMIN_NAV_FLAT.find((i) => i.id === id)!.path)?.moduleId).toBe(
        undefined,
      );
    }
  });

  it('registers the modules page under the system group with SYSTEM_READ', () => {
    const item = findAdminNavItemByPath('/admin/system/modules');
    expect(item?.id).toBe('modules');
    expect(item?.requiredPermissions).toEqual([PLATFORM_PERMISSIONS.SYSTEM_READ]);
  });

  it('resolves the module owning a path', () => {
    expect(findAdminNavModuleId('/admin/audit/logs')).toBe('audit');
    expect(findAdminNavModuleId('/admin/audit/content-moderation')).toBe('moderation');
    expect(findAdminNavModuleId('/admin/users')).toBeUndefined();
  });
});

describe('filterAdminNavByPermissions with disabled modules', () => {
  it('is unchanged when no module is disabled (default argument)', () => {
    const before = flatten(filterAdminNavByPermissions(ADMIN_NAV_ITEMS, ALL_PERMISSIONS));
    const after = flatten(
      filterAdminNavByPermissions(ADMIN_NAV_ITEMS, ALL_PERMISSIONS, new Set<PlatformModuleId>()),
    );
    expect(after).toEqual(before);
  });

  it('hides a leaf whose module is off', () => {
    const ids = flatten(
      filterAdminNavByPermissions(ADMIN_NAV_ITEMS, ALL_PERMISSIONS, new Set(['branding'])),
    );
    expect(ids).not.toContain('branding');
    expect(ids).toContain('users');
  });

  it('keeps the audit group visible for 内容审计 when only 审计 is off', () => {
    const ids = flatten(
      filterAdminNavByPermissions(ADMIN_NAV_ITEMS, ALL_PERMISSIONS, new Set(['audit'])),
    );
    expect(ids).toContain('audit');
    expect(ids).toContain('content-moderation');
    expect(ids).not.toContain('audit-logs');
  });

  it('drops the audit group entirely once every child module is off', () => {
    const ids = flatten(
      filterAdminNavByPermissions(
        ADMIN_NAV_ITEMS,
        ALL_PERMISSIONS,
        new Set(['audit', 'moderation']),
      ),
    );
    expect(ids).not.toContain('audit');
    expect(ids).not.toContain('content-moderation');
  });
});

describe('isAdminNavItemModuleDisabled', () => {
  it('is false for core items and for an unknown item', () => {
    expect(
      isAdminNavItemModuleDisabled(findAdminNavItemByPath('/admin/users'), new Set(['audit'])),
    ).toBe(false);
    expect(isAdminNavItemModuleDisabled(undefined, new Set(['audit']))).toBe(false);
  });

  it('is true only for the module that is actually off', () => {
    const item = findAdminNavItemByPath('/admin/agents');
    expect(isAdminNavItemModuleDisabled(item, new Set(['managedAgents']))).toBe(true);
    expect(isAdminNavItemModuleDisabled(item, new Set(['audit']))).toBe(false);
  });
});

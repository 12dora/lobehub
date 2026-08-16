import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminNavItem } from '@/enterprise/client/nav/adminNavMeta';

import GroupIndexRedirect from './GroupIndexRedirect';

const navigate = vi.fn();
const access = { permissions: [] as string[] };

/**
 * The real catalog has no group where a *hidden* child is authorized before a visible one,
 * so one synthetic group is appended to prove the two skip rules explicitly. Every other
 * assertion runs against the untouched production catalog.
 */
const { SYNTHETIC_GROUP } = vi.hoisted(() => ({
  SYNTHETIC_GROUP: {
    children: [
      {
        // Unauthorized → skipped even though it is first.
        id: 'synthetic-locked',
        labelKey: 'nav.system',
        path: '/admin/synthetic/locked',
        requiredPermissions: ['platform_audit:read:all'],
      },
      {
        // Authorized but hidden from the nav → must never be a redirect target.
        hideFromNav: true,
        id: 'synthetic-hidden',
        labelKey: 'nav.system',
        path: '/admin/synthetic/hidden',
        requiredPermissions: ['platform_user:read:all'],
      },
      {
        id: 'synthetic-visible',
        labelKey: 'nav.system',
        path: '/admin/synthetic/visible',
        requiredPermissions: ['platform_user:read:all'],
      },
    ],
    id: 'synthetic',
    // Pins a hidden child on purpose: the pin must be ignored, not followed.
    indexRedirectTo: 'synthetic-hidden',
    labelKey: 'nav.system',
    path: '/admin/synthetic',
    requiredPermissions: [],
  } satisfies AdminNavItem,
}));

vi.mock('@/enterprise/client/nav/adminNavMeta', async (importOriginal) => {
  const actual = (await importOriginal()) as { ADMIN_NAV_ITEMS: readonly AdminNavItem[] };
  return { ...actual, ADMIN_NAV_ITEMS: [...actual.ADMIN_NAV_ITEMS, SYNTHETIC_GROUP] };
});

vi.mock('react-router', () => ({ useNavigate: () => navigate }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Empty: ({ description }: any) =>
      React.createElement('div', { 'data-testid': 'group-empty' }, description),
    Text: ({ children, ...rest }: any) => React.createElement('span', rest, children),
  };
});

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => access,
}));

const renderGroup = (groupId: string, permissions: string[]) => {
  access.permissions = permissions;
  return render(<GroupIndexRedirect groupId={groupId} />);
};

describe('GroupIndexRedirect', () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  it('honours the pinned index child so /admin/system still lands on the status page', () => {
    // `system-general` is first in the menu, but the group pins `system-status` because
    // `/admin/system` used to *be* the status page.
    renderGroup('system', [PLATFORM_PERMISSIONS.SYSTEM_READ]);

    expect(navigate).toHaveBeenCalledWith('/admin/system/status', { replace: true });
    expect(screen.getByRole('status').textContent).toBe('groupRedirect.redirecting');
  });

  it('skips the system children the principal cannot open and lands on /admin/users', () => {
    // The pinned `system-status` is not permitted here, so the pin falls back to the first
    // reachable child: `system-general`, `identity-providers` and `branding` are all gated
    // on permissions this principal lacks.
    renderGroup('system', [PLATFORM_PERMISSIONS.USER_READ]);

    expect(navigate).toHaveBeenCalledWith('/admin/users', { replace: true });
  });

  it('falls back to the shell-only child when nothing else is granted', () => {
    // `unified-management` requires shell access only.
    renderGroup('system', []);

    expect(navigate).toHaveBeenCalledWith('/admin/unified', { replace: true });
  });

  it('skips hidden and unauthorized children, and ignores a pin that points at a hidden one', () => {
    // The synthetic fixture is built in a hoisted block (no import access), so guard the
    // literals against constant drift.
    expect(SYNTHETIC_GROUP.children?.[0].requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.AUDIT_READ,
    ]);
    expect(SYNTHETIC_GROUP.children?.[1].requiredPermissions).toEqual([
      PLATFORM_PERMISSIONS.USER_READ,
    ]);

    renderGroup('synthetic', [PLATFORM_PERMISSIONS.USER_READ]);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/admin/synthetic/visible', { replace: true });
  });

  it('shows the no-access empty state instead of redirecting when no child is reachable', () => {
    renderGroup('synthetic', []);

    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('group-empty').textContent).toBe('groupRedirect.noAccess');
  });

  it('resolves the ai and audit groups from the same catalog', () => {
    renderGroup('ai', [PLATFORM_PERMISSIONS.SKILL_READ]);
    expect(navigate).toHaveBeenCalledWith('/admin/ai/skills', { replace: true });

    navigate.mockClear();
    renderGroup('audit', [PLATFORM_PERMISSIONS.AUDIT_EXPORT]);
    expect(navigate).toHaveBeenCalledWith('/admin/audit/exports', { replace: true });
  });

  it('renders the empty state for an unknown group id', () => {
    renderGroup('does-not-exist', [PLATFORM_PERMISSIONS.SYSTEM_READ]);

    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('group-empty')).toBeTruthy();
  });
});

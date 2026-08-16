import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AdminSideNav from './AdminSideNav';

const navigate = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    permissions: [
      PLATFORM_PERMISSIONS.ADMIN_ACCESS,
      PLATFORM_PERMISSIONS.USER_READ,
      PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
      PLATFORM_PERMISSIONS.POLICY_READ,
    ],
    status: 'allowed',
  }),
}));

// Spacing props are surfaced as data-* so the vertical-rhythm invariant can be asserted.
vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Accordion: ({ children, gap }: any) =>
      React.createElement(
        'div',
        { 'data-gap': String(gap), 'data-testid': 'nav-accordion' },
        children,
      ),
    AccordionItem: ({ children, title }: any) => React.createElement('div', null, title, children),
    Flexbox: ({ children, gap, style }: any) =>
      React.createElement(
        'div',
        {
          'data-gap': gap === undefined ? undefined : String(gap),
          'data-padding-block-start':
            style?.paddingBlockStart === undefined ? undefined : String(style.paddingBlockStart),
          'data-testid': 'nav-flexbox',
        },
        children,
      ),
    Icon: () => null,
    Text: ({ children }: any) => React.createElement('span', null, children),
  };
});

vi.mock('@/features/NavPanel/components/NavItem', async () => {
  const React = await import('react');
  return {
    default: ({ title, active, icon: _icon, ...rest }: any) =>
      React.createElement(
        'div',
        { 'data-active': String(!!active), 'data-testid': 'nav-item', ...rest },
        title,
      ),
  };
});

describe('AdminSideNav (canonical NavItem)', () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  it('renders permission-filtered nav with NavItem active semantics', () => {
    render(
      <MemoryRouter initialEntries={['/admin/users']}>
        <AdminSideNav />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('nav.aria')).toBeTruthy();
    expect(screen.getByText('nav.overview')).toBeTruthy();
    expect(screen.getByText('nav.users')).toBeTruthy();
    expect(screen.getByText('nav.aiProviders')).toBeTruthy();
    // `users` / `unified-management` now render inside the `system` group header.
    expect(screen.getByText('nav.system')).toBeTruthy();
    // Managed resources is hidden from the nav (merged into the unified-management surface).
    expect(screen.getByText('nav.unifiedManagement')).toBeTruthy();
    expect(screen.queryByText('nav.managedResources')).toBeNull();
    expect(screen.queryByText('nav.userDetail')).toBeNull();
    // audit group only appears when at least one child permission is granted
    expect(screen.queryByText('nav.audit')).toBeNull();
    expect(screen.queryByText('nav.auditLogs')).toBeNull();
  });

  it('link navigates via router (no full reload)', () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <AdminSideNav />
      </MemoryRouter>,
    );

    const usersLink = screen.getByText('nav.users').closest('a');
    expect(usersLink).toBeTruthy();
    expect(usersLink?.getAttribute('href')).toBe('/admin/users');

    fireEvent.click(usersLink!);
    expect(navigate).toHaveBeenCalledWith('/admin/users');
  });

  it('keeps one vertical rhythm across group boundaries', () => {
    render(
      <MemoryRouter initialEntries={['/admin/users']}>
        <AdminSideNav />
      </MemoryRouter>,
    );

    // The Accordion gap separates top-level rows AND a group's last child from the next
    // top-level row, so every in-group gap must match it exactly — otherwise group
    // boundaries read as extra whitespace.
    const rowGap = screen.getByTestId('nav-accordion').dataset.gap;
    expect(rowGap).toBeTruthy();

    const groupContents = screen
      .getAllByTestId('nav-flexbox')
      .filter((node) => node.dataset.paddingBlockStart !== undefined);
    expect(groupContents.length).toBeGreaterThan(0);

    for (const content of groupContents) {
      // child ↔ child
      expect(content.dataset.gap).toBe(rowGap);
      // group header ↔ its first child (`.accordion-item` has no gap of its own)
      expect(content.dataset.paddingBlockStart).toBe(rowGap);
    }
  });

  it('marks the active page with aria-current', () => {
    render(
      <MemoryRouter initialEntries={['/admin/users']}>
        <AdminSideNav />
      </MemoryRouter>,
    );

    const usersLink = screen.getByText('nav.users').closest('a');
    expect(usersLink?.getAttribute('aria-current')).toBe('page');
  });
});

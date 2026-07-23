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

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Accordion: ({ children }: any) => React.createElement('div', null, children),
    AccordionItem: ({ children, title }: any) => React.createElement('div', null, title, children),
    Flexbox: ({ children }: any) => React.createElement('div', null, children),
    Icon: () => null,
    Text: ({ children }: any) => React.createElement('span', null, children),
  };
});

vi.mock('@/features/NavPanel/components/NavItem', async () => {
  const React = await import('react');
  return {
    default: ({ title, active, icon, ...rest }: any) =>
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

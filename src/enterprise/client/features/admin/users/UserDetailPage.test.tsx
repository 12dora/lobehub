/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import UserDetailPage from './UserDetailPage';

const getMock = vi.fn();
const auditMock = vi.fn();
const banMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: { colorBorderSecondary: '#eee' },
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Avatar: () => null,
    Flexbox: ({ children }: any) => React.createElement('div', null, children),
    Tag: ({ children }: any) => React.createElement('span', null, children),
    Text: ({ children, ...rest }: any) => React.createElement('span', rest, children),
  };
});

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Button: ({ children, onClick, ...rest }: any) =>
      React.createElement('button', { onClick, ...rest }, children),
    Tabs: ({ items, onChange, activeKey }: any) =>
      React.createElement(
        'div',
        { role: 'tablist' },
        items.map((item: any) =>
          React.createElement(
            'button',
            {
              'key': item.key,
              'role': 'tab',
              'aria-selected': activeKey === item.key,
              'type': 'button',
              'onClick': () => onChange?.(item.key),
            },
            item.label,
          ),
        ),
      ),
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ children, title, actions, toolbar }: any) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="actions">{actions}</div>
      <div data-testid="toolbar">{toolbar}</div>
      {children}
    </div>
  ),
}));

vi.mock('../primitives/StatusBadge', () => ({
  default: ({ status }: any) => <span>{status}</span>,
}));

const permissionsRef = { current: [PLATFORM_PERMISSIONS.USER_READ] as string[] };

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    permissions: permissionsRef.current,
    status: 'allowed',
    roles: [],
    error: null,
    refresh: async () => undefined,
    retryable: false,
  }),
}));

vi.mock('./hooks/useAdminUsers', () => ({
  useFetchAdminUserDetail: (userId?: string) => ({
    data: userId
      ? {
          avatar: null,
          banExpires: null,
          banReason: null,
          banned: false,
          createdAt: new Date(),
          email: 'bob@example.com',
          emailVerified: true,
          fullName: 'Bob',
          id: userId,
          lastActiveAt: null,
          providers: [{ providerId: 'credential', accountIdHint: '…1234', createdAt: null }],
          roles: [{ id: 'r1', name: 'user_admin', displayName: 'User Admin', expiresAt: null }],
          sessionCount: 1,
          sessions: [
            {
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + 3600_000),
              id: 'sess-1',
              ipAddress: '1.2.3.4',
              updatedAt: null,
              userAgent: 'test-agent',
            },
          ],
          status: 'active',
          username: 'bob',
          // adversarial secrets must not be rendered if present on object
          password: 'secret-hash',
          token: 'session-token-leak',
        }
      : undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useFetchAdminUserAuditTrail: (_params: unknown, enabled: boolean) => {
    if (enabled) {
      void auditMock();
    }
    return {
      data: enabled ? { items: [], nextCursor: null } : undefined,
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    };
  },
  useAdminUserMutations: () => ({
    banUser: banMock,
    unbanUser: vi.fn(),
    revokeSessions: vi.fn(),
    replaceGlobalRoles: vi.fn(),
  }),
}));

vi.mock('./modals/actions', () => ({
  openBanUserModal: vi.fn(({ onConfirm }: any) => {
    void onConfirm({ reason: 'test ban' });
  }),
  openUnbanUserModal: vi.fn(),
  openRevokeSessionsModal: vi.fn(),
  openReplaceRolesModal: vi.fn(),
}));

describe('UserDetailPage', () => {
  beforeEach(() => {
    getMock.mockReset();
    auditMock.mockReset();
    banMock.mockReset();
    permissionsRef.current = [
      PLATFORM_PERMISSIONS.USER_READ,
      PLATFORM_PERMISSIONS.USER_BAN,
      PLATFORM_PERMISSIONS.USER_SESSION_REVOKE,
      PLATFORM_PERMISSIONS.USER_ROLE_MANAGE,
    ];
  });

  it('renders overview and does not expose secrets', () => {
    render(
      <MemoryRouter initialEntries={['/admin/users/u-bob']}>
        <Routes>
          <Route element={<UserDetailPage />} path="/admin/users/:id" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.getByText('bob@example.com')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/secret-hash|session-token-leak/);
    expect(screen.getByText('users.actions.ban')).toBeTruthy();
  });

  it('hides ban action without ban permission', () => {
    permissionsRef.current = [PLATFORM_PERMISSIONS.USER_READ];
    render(
      <MemoryRouter initialEntries={['/admin/users/u-bob']}>
        <Routes>
          <Route element={<UserDetailPage />} path="/admin/users/:id" />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText('users.actions.ban')).toBeNull();
    expect(screen.queryByText('users.actions.revokeSessions')).toBeNull();
    expect(screen.queryByText('users.actions.replaceRoles')).toBeNull();
  });

  it('does not request audit trail without audit permission even when tab is selected', async () => {
    permissionsRef.current = [PLATFORM_PERMISSIONS.USER_READ];
    render(
      <MemoryRouter initialEntries={['/admin/users/u-bob']}>
        <Routes>
          <Route element={<UserDetailPage />} path="/admin/users/:id" />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.audit' }));
    await waitFor(() => {
      expect(screen.getByText('users.audit.noPermission')).toBeTruthy();
    });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('requests audit only when permitted and tab active', async () => {
    permissionsRef.current = [PLATFORM_PERMISSIONS.USER_READ, PLATFORM_PERMISSIONS.AUDIT_READ];
    render(
      <MemoryRouter initialEntries={['/admin/users/u-bob']}>
        <Routes>
          <Route element={<UserDetailPage />} path="/admin/users/:id" />
        </Routes>
      </MemoryRouter>,
    );

    expect(auditMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.audit' }));
    await waitFor(() => {
      expect(auditMock).toHaveBeenCalled();
    });
  });
});

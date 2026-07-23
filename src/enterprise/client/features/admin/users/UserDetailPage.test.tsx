/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import UserDetailPage from './UserDetailPage';

const auditMock = vi.fn();
const banMock = vi.fn();
const revokeMock = vi.fn();
const replaceRolesMock = vi.fn();
const mutateMock = vi.fn();

let detailState: {
  data?: any;
  error?: unknown;
  isLoading: boolean;
} = { isLoading: false };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string; count?: number }) =>
      opts?.defaultValue ?? (opts?.count != null ? `${k}:${opts.count}` : k),
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {
    borderRadius: '8px',
    borderRadiusLG: '12px',
    colorBorderSecondary: '#eee',
    colorError: 'red',
    colorErrorBg: '#fee',
    colorErrorBorder: 'red',
    colorTextSecondary: '#888',
    fontSizeLG: '16px',
  },
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Avatar: () => null,
    Flexbox: ({ children }: any) => React.createElement('div', null, children),
    Icon: () => null,
    Tag: ({ children, ...rest }: any) => React.createElement('span', rest, children),
    Text: ({ children, as: As, ...rest }: any) => React.createElement(As || 'span', rest, children),
    Tooltip: ({ children, title }: any) =>
      React.createElement('div', { 'data-tooltip': title }, children),
  };
});

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Button: ({ children, onClick, ...rest }: any) =>
      React.createElement('button', { onClick, type: 'button', ...rest }, children),
    Tabs: ({ items, onChange, activeKey }: any) =>
      React.createElement(
        'div',
        { role: 'tablist' },
        items.map((item: any) =>
          React.createElement(
            'button',
            {
              'aria-selected': activeKey === item.key,
              'key': item.key,
              'role': 'tab',
              'type': 'button',
              'onClick': () => onChange?.(item.key),
            },
            item.label,
          ),
        ),
      ),
    toast: { error: vi.fn(), success: vi.fn() },
  };
});

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ children, title, description, toolbar }: any) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="description">{description}</div>
      <div data-testid="toolbar">{toolbar}</div>
      {children}
    </div>
  ),
}));

vi.mock('../primitives/StatusBadge', () => ({
  default: ({ status }: any) => <span>{status}</span>,
}));

const permissionsRef = { current: [PLATFORM_PERMISSIONS.USER_READ] as string[] };
const rolesRef = { current: [{ displayName: 'User Admin', name: 'user_admin' }] };
const authMethodRef = { current: 'better-auth' as const };

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: authMethodRef.current,
    error: null,
    permissions: permissionsRef.current,
    refresh: async () => undefined,
    retryable: false,
    roles: rolesRef.current,
    status: 'allowed',
  }),
}));

const openBan = vi.fn();
const openUnban = vi.fn();
const openDelete = vi.fn();
const openRevoke = vi.fn();
const openRevokeSingle = vi.fn();
const openRoles = vi.fn();
const openRevokeRole = vi.fn();

vi.mock('./modals/actions', () => ({
  openBanUserModal: (...a: unknown[]) => openBan(...a),
  openUnbanUserModal: (...a: unknown[]) => openUnban(...a),
  openDeleteUserModal: (...a: unknown[]) => openDelete(...a),
  openRevokeSessionsModal: (...a: unknown[]) => openRevoke(...a),
  openRevokeSingleSessionModal: (...a: unknown[]) => openRevokeSingle(...a),
  openReplaceRolesModal: (...a: unknown[]) => openRoles(...a),
  openRevokeRoleModal: (...a: unknown[]) => openRevokeRole(...a),
  getEligibleAssignableRoles: (roles: { name: string }[]) => {
    const isSuper = roles.some((r) => r.name === 'super_admin');
    const all = [
      'super_admin',
      'user_admin',
      'ai_admin',
      'identity_admin',
      'auditor',
      'platform_user',
    ];
    return isSuper ? all : all.filter((r) => r !== 'super_admin');
  },
}));

vi.mock('./hooks/useAdminUsers', () => ({
  useFetchAdminUserDetail: () => ({
    data: detailState.data,
    error: detailState.error,
    isLoading: detailState.isLoading,
    mutate: mutateMock,
  }),
  useFetchAdminUserAuditTrail: (_params: unknown, enabled: boolean) => {
    if (enabled) void auditMock();
    return {
      data: enabled ? { items: [], nextCursor: null } : undefined,
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    };
  },
  useAdminUserMutations: () => ({
    banUser: banMock,
    deleteUser: vi.fn(),
    replaceGlobalRoles: replaceRolesMock,
    revokeSessions: revokeMock,
    unbanUser: vi.fn(),
  }),
}));

const baseUser = {
  avatar: null,
  dingtalkTitle: null,
  banExpires: null,
  banReason: null,
  banned: false,
  createdAt: new Date(),
  email: 'bob@example.com',
  emailVerified: true,
  fullName: 'Bob',
  id: 'u-bob',
  isSelf: false,
  lastActiveAt: null,
  providers: [{ accountIdHint: '…1234', createdAt: null, providerId: 'credential' }],
  roles: [{ displayName: 'User Admin', expiresAt: null, id: 'r1', name: 'user_admin' }],
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
  status: 'active' as const,
  username: 'bob',
  password: 'secret-hash',
  token: 'session-token-leak',
};

const renderDetail = (path = '/admin/users/u-bob') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<UserDetailPage />} path="/admin/users/:id" />
        <Route element={<div>list</div>} path="/admin/users" />
      </Routes>
    </MemoryRouter>,
  );

describe('UserDetailPage', () => {
  beforeEach(() => {
    auditMock.mockReset();
    banMock.mockReset();
    revokeMock.mockReset();
    openBan.mockReset();
    openDelete.mockReset();
    openRevoke.mockReset();
    openRevokeSingle.mockReset();
    openRoles.mockReset();
    openRevokeRole.mockReset();
    mutateMock.mockReset();
    permissionsRef.current = [
      PLATFORM_PERMISSIONS.USER_READ,
      PLATFORM_PERMISSIONS.USER_BAN,
      PLATFORM_PERMISSIONS.USER_DELETE,
      PLATFORM_PERMISSIONS.USER_SESSION_REVOKE,
      PLATFORM_PERMISSIONS.USER_ROLE_MANAGE,
    ];
    rolesRef.current = [{ displayName: 'User Admin', name: 'user_admin' }];
    detailState = {
      data: { ...baseUser },
      error: undefined,
      isLoading: false,
    };
  });

  it('renders overview heading and does not expose secrets', () => {
    renderDetail();
    expect(screen.getByRole('heading', { level: 1, name: 'Bob' })).toBeTruthy();
    expect(within(screen.getByTestId('description')).getByText('bob@example.com')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/secret-hash|session-token-leak/);
    // Credential-only sample → local source tag only
    expect(screen.getByTestId('user-source-local')).toBeTruthy();
    expect(screen.queryByTestId('user-source-sso')).toBeNull();
  });

  it('renders job title on overview when present', () => {
    detailState = {
      data: { ...baseUser, dingtalkTitle: '高级工程师' },
      error: undefined,
      isLoading: false,
    };
    renderDetail();
    expect(screen.getByText('users.overview.jobTitle')).toBeTruthy();
    expect(screen.getByText('高级工程师')).toBeTruthy();
  });

  it('shows loading before data', () => {
    detailState = { data: undefined, error: undefined, isLoading: true };
    renderDetail();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText('users.detail.loading')).toBeTruthy();
  });

  it('shows not-found for PLATFORM_NOT_FOUND only', () => {
    detailState = {
      data: undefined,
      error: { message: 'PLATFORM_NOT_FOUND', data: { code: 'PLATFORM_NOT_FOUND' } },
      isLoading: false,
    };
    renderDetail();
    expect(screen.getByText('users.detail.notFoundTitle')).toBeTruthy();
    expect(screen.queryByText('primitives.dataTable.retry')).toBeNull();
  });

  it('shows generic error + retry for network failures', () => {
    detailState = {
      data: undefined,
      error: new Error('Network down'),
      isLoading: false,
    };
    renderDetail();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('primitives.dataTable.retry')).toBeTruthy();
    fireEvent.click(screen.getByText('primitives.dataTable.retry'));
    expect(mutateMock).toHaveBeenCalled();
  });

  it('hides ban/delete for self on overview and passes isSelf to revoke-all', () => {
    detailState = {
      data: { ...baseUser, isSelf: true },
      error: undefined,
      isLoading: false,
    };
    renderDetail();
    // Overview account actions are hidden for self — no ban/delete buttons.
    expect(screen.getByText('users.overview.selfActionsHidden')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'users.actions.ban' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'users.actions.delete' })).toBeNull();

    // Revoke-all lives on the sessions tab and still carries isSelf.
    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'users.sessions.openRevoke' }));
    expect(openRevoke).toHaveBeenCalledTimes(1);
    expect(openRevoke.mock.calls[0]![0].isSelf).toBe(true);
    expect(banMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('passes isSelf false for other users from the sessions revoke-all button', () => {
    renderDetail();
    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'users.sessions.openRevoke' }));
    expect(openRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ isSelf: false, userId: 'u-bob' }),
    );
  });

  it('opens delete for other users from overview', () => {
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'users.actions.delete' }));
    expect(openDelete).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-bob' }));
  });

  it('opens single-session revoke from a session card', () => {
    renderDetail();
    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'users.sessions.revokeOne' }));
    expect(openRevokeSingle).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', userId: 'u-bob' }),
    );
  });

  it('opens per-role revoke from the access tab with the remaining roles', () => {
    renderDetail();
    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.access' }));
    fireEvent.click(screen.getByRole('button', { name: 'users.modals.revokeRole.confirm' }));
    expect(openRevokeRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-bob', remainingRoleNames: [] }),
    );
  });

  it('hides write actions without permissions', () => {
    permissionsRef.current = [PLATFORM_PERMISSIONS.USER_READ];
    renderDetail();
    expect(screen.queryByRole('button', { name: 'users.actions.ban' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'users.actions.delete' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.sessions' }));
    expect(screen.queryByRole('button', { name: 'users.sessions.openRevoke' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'users.sessions.revokeOne' })).toBeNull();
  });

  it('does not request audit without permission', async () => {
    permissionsRef.current = [PLATFORM_PERMISSIONS.USER_READ];
    renderDetail();
    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.audit' }));
    await waitFor(() => {
      expect(screen.getByText('users.audit.noPermission')).toBeTruthy();
    });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('requests audit only when permitted and tab active', async () => {
    permissionsRef.current = [PLATFORM_PERMISSIONS.USER_READ, PLATFORM_PERMISSIONS.AUDIT_READ];
    renderDetail();
    expect(auditMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.audit' }));
    await waitFor(() => expect(auditMock).toHaveBeenCalled());
  });

  it('role modal receives actor roles (user_admin cannot include super)', () => {
    renderDetail();
    fireEvent.click(screen.getByRole('tab', { name: 'users.tabs.access' }));
    fireEvent.click(screen.getByRole('button', { name: 'users.actions.replaceRoles' }));
    expect(openRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: [{ displayName: 'User Admin', name: 'user_admin' }],
      }),
    );
  });
});

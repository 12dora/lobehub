import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import AdminAccessProvider from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPermissionOutlet from './AdminPermissionOutlet';
import AdminRootGate from './AdminRootGate';

const openLogin = vi.fn(async () => {
  window.location.href = `/signin?callbackUrl=${encodeURIComponent(window.location.href)}`;
});

const fetchAccess = vi.fn();
const childBusinessFetch = vi.fn();

const authState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: false,
}));

const serverConfigState = vi.hoisted(() => ({
  platformAdmin: true,
  serverConfigInit: true,
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: any) => unknown) =>
    selector({
      isLoaded: authState.isLoaded,
      isSignedIn: authState.isSignedIn,
      openLogin,
    }),
}));

vi.mock('@/store/user/slices/auth/selectors', () => ({
  authSelectors: {
    isLoaded: (s: any) => s.isLoaded,
    isLogin: (s: any) => s.isSignedIn,
  },
}));

vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (s: any) => unknown) =>
    selector({
      serverConfig: {
        enterprise: {
          enabled: serverConfigState.platformAdmin,
          platformAdmin: serverConfigState.platformAdmin,
        },
      },
      serverConfigInit: serverConfigState.serverConfigInit,
    }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/enterprise/client/services/adminAuth', () => ({
  fetchAdminAccess: () => fetchAccess(),
  getAdminAccessErrorCode: (e: any) => e?.data?.code,
  isAdminAccessErrorRetryable: (e: any) => {
    const code = e?.data?.code;
    return code !== 'UNAUTHORIZED' && code !== 'FORBIDDEN';
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Avoid Motion/ConfigProvider requirements from @lobehub/ui in unit tests
vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Accordion: ({ children }: any) => React.createElement('div', null, children),
    AccordionItem: ({ children, title }: any) => React.createElement('div', null, title, children),
    Button: ({ children, ...rest }: any) => React.createElement('button', rest, children),
    Empty: ({ description }: any) => React.createElement('div', null, description),
    Flexbox: ({ children }: any) => React.createElement('div', null, children),
    FluentEmoji: () => null,
    Text: ({ children }: any) => React.createElement('span', null, children),
  };
});

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Button: ({ children, ...rest }: any) => React.createElement('button', rest, children),
  };
});

vi.mock('@/features/NavPanel/components/NavItem', async () => {
  const React = await import('react');
  return {
    default: ({ title, active }: any) =>
      React.createElement('div', { 'data-active': String(!!active) }, title),
  };
});

vi.mock('@/components/NeuralNetworkLoading', () => ({
  default: () => null,
}));

const BusinessChild = () => {
  childBusinessFetch();
  return <div data-testid="business-child">secret data</div>;
};

const renderGate = (initialPath = '/admin') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<AdminRootGate />} path="/admin">
          <Route index element={<BusinessChild />} />
          <Route element={<BusinessChild />} path="users" />
          <Route element={<BusinessChild />} path="ai/providers/:id" />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

describe('AdminRootGate (production mount)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isLoaded = true;
    authState.isSignedIn = false;
    serverConfigState.platformAdmin = true;
    serverConfigState.serverConfigInit = true;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        href: 'http://localhost/admin/users',
        pathname: '/admin/users',
        toString: () => 'http://localhost/admin/users',
      },
    });
  });

  it('flag off: no admin fetch and no business child', async () => {
    serverConfigState.platformAdmin = false;
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('feature.off.title')).toBeTruthy();
    });
    expect(fetchAccess).not.toHaveBeenCalled();
    expect(childBusinessFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('business-child')).toBeNull();
  });

  it('anonymous: calls openLogin with safe callbackUrl and mounts no child', async () => {
    authState.isSignedIn = false;
    renderGate('/admin/users');

    await waitFor(() => {
      expect(openLogin).toHaveBeenCalled();
    });
    expect(fetchAccess).not.toHaveBeenCalled();
    expect(childBusinessFetch).not.toHaveBeenCalled();
    expect(screen.getByText('access.signInRedirect')).toBeTruthy();
  });

  it('ordinary user forbidden: no business child fetch', async () => {
    authState.isSignedIn = true;
    fetchAccess.mockResolvedValueOnce({
      hasAdminAccess: false,
      permissions: [],
      roles: [],
    });

    renderGate();

    await waitFor(() => {
      expect(screen.getByText('access.forbidden.title')).toBeTruthy();
    });
    expect(fetchAccess).toHaveBeenCalledTimes(1);
    expect(childBusinessFetch).not.toHaveBeenCalled();
  });

  it('allowed admin: shell mounts and child can render', async () => {
    authState.isSignedIn = true;
    fetchAccess.mockResolvedValueOnce({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.USER_READ],
      roles: [{ displayName: 'Admin', name: 'super_admin' }],
    });

    renderGate('/admin');

    await waitFor(() => {
      expect(screen.getByTestId('business-child')).toBeTruthy();
    });
    expect(childBusinessFetch).toHaveBeenCalled();
  });

  it('error non-retryable 403 does not mount child', async () => {
    authState.isSignedIn = true;
    fetchAccess.mockRejectedValueOnce({ data: { code: 'FORBIDDEN' }, message: 'FORBIDDEN' });

    renderGate();

    await waitFor(() => {
      expect(screen.getByText('access.error.title')).toBeTruthy();
    });
    expect(screen.queryByText('access.error.retry')).toBeNull();
    expect(childBusinessFetch).not.toHaveBeenCalled();
  });
});

describe('AdminPermissionOutlet permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childBusinessFetch.mockClear();
  });

  it('read-only provider list vs edit detail 403', async () => {
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      roles: [],
    });

    render(
      <MemoryRouter initialEntries={['/admin/ai/providers/p1']}>
        <AdminAccessProvider fetchAccess={fetchAccess}>
          <Routes>
            <Route element={<AdminPermissionOutlet />} path="/admin">
              <Route element={<BusinessChild />} path="ai/providers/:id" />
            </Route>
          </Routes>
        </AdminAccessProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('page.forbidden.title')).toBeTruthy();
    });
    expect(childBusinessFetch).not.toHaveBeenCalled();
  });

  it('UPDATE principal reaches provider detail placeholder', async () => {
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE],
      roles: [],
    });

    render(
      <MemoryRouter initialEntries={['/admin/ai/providers/p1']}>
        <AdminAccessProvider fetchAccess={fetchAccess}>
          <Routes>
            <Route element={<AdminPermissionOutlet />} path="/admin">
              <Route element={<BusinessChild />} path="ai/providers/:id" />
            </Route>
          </Routes>
        </AdminAccessProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('business-child')).toBeTruthy();
    });
  });

  it('unknown nested path shows admin 404 without child fetch', async () => {
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS],
      roles: [],
    });

    render(
      <MemoryRouter initialEntries={['/admin/unknown-thing']}>
        <AdminAccessProvider fetchAccess={fetchAccess}>
          <Routes>
            <Route element={<AdminPermissionOutlet />} path="/admin/*">
              <Route element={<BusinessChild />} path="*" />
            </Route>
          </Routes>
        </AdminAccessProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('notFound.title')).toBeTruthy();
    });
    expect(childBusinessFetch).not.toHaveBeenCalled();
  });
});

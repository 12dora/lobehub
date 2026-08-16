import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import AdminAccessProvider from '@/enterprise/client/providers/AdminAccessProvider';
import { createAdminRouteTree } from '@/enterprise/client/routes/admin/createAdminRouteTree';

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
    // Nav group headers (e.g. the `system` group) render an Icon.
    Icon: () => null,
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

const ExtensionSentinel = () => {
  childBusinessFetch();
  return <div data-testid="extension-sentinel">extension secret</div>;
};

/** Data router required for useMatches() inside AdminPermissionOutlet. */
const renderDataRouter = (
  routes: Parameters<typeof createMemoryRouter>[0],
  initialPath: string,
) => {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  return render(<RouterProvider router={router} />);
};

const renderGate = (initialPath = '/admin') =>
  renderDataRouter(
    [
      {
        children: [
          { element: <BusinessChild />, index: true },
          { element: <BusinessChild />, path: 'users' },
          { element: <BusinessChild />, path: 'ai/providers/:id' },
          { element: <BusinessChild />, path: 'connectors/:id' },
        ],
        element: <AdminRootGate />,
        path: '/admin',
      },
    ],
    initialPath,
  );

const renderPermissionTree = (initialPath: string, childPath: string) =>
  renderDataRouter(
    [
      {
        children: [{ element: <BusinessChild />, path: childPath }],
        element: (
          <AdminAccessProvider fetchAccess={fetchAccess}>
            <AdminPermissionOutlet />
          </AdminAccessProvider>
        ),
        path: '/admin',
      },
    ],
    initialPath,
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

  it('provider reader reaches the read-only detail route', async () => {
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.AI_PROVIDER_READ],
      roles: [],
    });

    renderPermissionTree('/admin/ai/providers/p1', 'ai/providers/:id');

    await waitFor(() => {
      expect(screen.getByTestId('business-child')).toBeTruthy();
    });
  });

  it('provider UPDATE without READ is forbidden before business data mounts', async () => {
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE],
      roles: [],
    });

    renderPermissionTree('/admin/ai/providers/p1', 'ai/providers/:id');

    await waitFor(() => {
      expect(screen.getByText('page.forbidden.title')).toBeTruthy();
    });
    expect(childBusinessFetch).not.toHaveBeenCalled();
  });

  it('unknown nested path shows admin 404 without child fetch', async () => {
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS],
      roles: [],
    });

    renderDataRouter(
      [
        {
          children: [{ element: <BusinessChild />, path: '*' }],
          element: (
            <AdminAccessProvider fetchAccess={fetchAccess}>
              <AdminPermissionOutlet />
            </AdminAccessProvider>
          ),
          path: '/admin',
        },
      ],
      '/admin/unknown-thing',
    );

    await waitFor(() => {
      expect(screen.getByText('notFound.title')).toBeTruthy();
    });
    expect(childBusinessFetch).not.toHaveBeenCalled();
  });

  it('connector detail without READ is forbidden before business data mounts', async () => {
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS],
      roles: [],
    });

    renderPermissionTree('/admin/connectors/c1', 'connectors/:id');

    await waitFor(() => {
      expect(screen.getByText('page.forbidden.title')).toBeTruthy();
    });
    expect(childBusinessFetch).not.toHaveBeenCalled();
  });

  it('connector auditor with READ reaches the read-only detail route', async () => {
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.CONNECTOR_READ],
      roles: [{ displayName: 'Auditor', name: 'auditor' }],
    });

    renderPermissionTree('/admin/connectors/c1', 'connectors/:id');

    await waitFor(() => {
      expect(screen.getByTestId('business-child')).toBeTruthy();
    });
  });
});

describe('registered extension routes under AdminRootGate', () => {
  const extensionRoutes = [
    {
      element: <ExtensionSentinel />,
      handle: {
        admin: {
          id: 'ext-sentinel',
          requiredPermissions: [PLATFORM_PERMISSIONS.SYSTEM_READ],
        },
      },
      path: 'extensions/sentinel',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    childBusinessFetch.mockClear();
    authState.isLoaded = true;
    authState.isSignedIn = false;
    serverConfigState.platformAdmin = true;
    serverConfigState.serverConfigInit = true;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        href: 'http://localhost/admin/extensions/sentinel',
        pathname: '/admin/extensions/sentinel',
        toString: () => 'http://localhost/admin/extensions/sentinel',
      },
    });
  });

  const renderExtensionTree = () =>
    renderDataRouter(createAdminRouteTree(extensionRoutes), '/admin/extensions/sentinel');

  it('anonymous: never mounts extension sentinel', async () => {
    authState.isSignedIn = false;
    renderExtensionTree();

    await waitFor(() => {
      expect(screen.getByText('access.signInRedirect')).toBeTruthy();
    });
    expect(childBusinessFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('extension-sentinel')).toBeNull();
  });

  it('ordinary user: shell forbidden, sentinel never mounts', async () => {
    authState.isSignedIn = true;
    fetchAccess.mockResolvedValue({
      hasAdminAccess: false,
      permissions: [],
      roles: [],
    });
    renderExtensionTree();

    await waitFor(() => {
      expect(screen.getByText('access.forbidden.title')).toBeTruthy();
    });
    expect(childBusinessFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('extension-sentinel')).toBeNull();
  });

  it('admin without extension permission: page 403, sentinel never mounts', async () => {
    authState.isSignedIn = true;
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.USER_READ],
      roles: [],
    });
    renderExtensionTree();

    await waitFor(() => {
      expect(screen.getByText('page.forbidden.title')).toBeTruthy();
    });
    expect(childBusinessFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('extension-sentinel')).toBeNull();
  });

  it('authorized admin: extension sentinel mounts under gates', async () => {
    authState.isSignedIn = true;
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.SYSTEM_READ],
      roles: [],
    });
    renderExtensionTree();

    await waitFor(() => {
      expect(screen.getByTestId('extension-sentinel')).toBeTruthy();
    });
    expect(childBusinessFetch).toHaveBeenCalled();
  });

  it('nested child with empty requiredPermissions cannot override parent permission', async () => {
    authState.isSignedIn = true;
    // Has admin shell access but lacks parent SYSTEM_READ.
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [PLATFORM_PERMISSIONS.ADMIN_ACCESS, PLATFORM_PERMISSIONS.USER_READ],
      roles: [],
    });

    const nestedExtensionRoutes = [
      {
        children: [
          {
            element: <ExtensionSentinel />,
            handle: {
              admin: {
                id: 'ext-child-empty',
                // Empty = access-only at this segment; must still satisfy parent.
                requiredPermissions: [] as const,
              },
            },
            path: 'leaf',
          },
        ],
        handle: {
          admin: {
            id: 'ext-parent',
            requiredPermissions: [PLATFORM_PERMISSIONS.SYSTEM_READ],
          },
        },
        path: 'extensions/nested',
      },
    ];

    renderDataRouter(createAdminRouteTree(nestedExtensionRoutes), '/admin/extensions/nested/leaf');

    await waitFor(() => {
      expect(screen.getByText('page.forbidden.title')).toBeTruthy();
    });
    expect(childBusinessFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('extension-sentinel')).toBeNull();
  });

  it('nested child requires union of parent + child permissions', async () => {
    authState.isSignedIn = true;
    fetchAccess.mockResolvedValue({
      hasAdminAccess: true,
      permissions: [
        PLATFORM_PERMISSIONS.ADMIN_ACCESS,
        PLATFORM_PERMISSIONS.SYSTEM_READ,
        PLATFORM_PERMISSIONS.USER_READ,
      ],
      roles: [],
    });

    const nestedExtensionRoutes = [
      {
        children: [
          {
            element: <ExtensionSentinel />,
            handle: {
              admin: {
                id: 'ext-child',
                requiredPermissions: [PLATFORM_PERMISSIONS.USER_READ],
              },
            },
            path: 'leaf',
          },
        ],
        handle: {
          admin: {
            id: 'ext-parent',
            requiredPermissions: [PLATFORM_PERMISSIONS.SYSTEM_READ],
          },
        },
        path: 'extensions/nested',
      },
    ];

    renderDataRouter(createAdminRouteTree(nestedExtensionRoutes), '/admin/extensions/nested/leaf');

    await waitFor(() => {
      expect(screen.getByTestId('extension-sentinel')).toBeTruthy();
    });
    expect(childBusinessFetch).toHaveBeenCalled();
  });
});

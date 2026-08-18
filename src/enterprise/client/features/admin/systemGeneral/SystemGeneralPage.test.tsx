// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import SystemGeneralPage from './SystemGeneralPage';

const mocks = vi.hoisted(() => ({
  admin: { authMethod: 'better-auth', permissions: [] as string[], status: 'allowed' },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Tabs: ({
    activeKey,
    items,
    onChange,
  }: {
    activeKey: string;
    items: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) => (
    <div>
      {items.map((item) => (
        <button
          data-active={item.key === activeKey}
          data-testid={`tab-${item.key}`}
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => mocks.admin,
}));

vi.mock('@/enterprise/client/services/adminSystem', () => ({ adminSystemService: {} }));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({
    children,
    title,
    toolbar,
  }: {
    children?: ReactNode;
    title?: ReactNode;
    toolbar?: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {toolbar}
      {children}
    </div>
  ),
}));

vi.mock('./hooks', () => ({
  useAdminBrowserProfile: () => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useAdminBrowserProfileOptions: () => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useAdminInfraSettings: () => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useInfraDependencyProbe: () => ({ busy: {}, results: {}, run: vi.fn() }),
}));

vi.mock('./SystemGeneralPageView', () => ({
  SystemGeneralPageView: () => <div data-testid="tab-body-infrastructure" />,
}));

vi.mock('../networkProxy/NetworkProxyTab', () => ({
  default: ({ canManage, enabled }: { canManage: boolean; enabled: boolean }) => (
    <div
      data-can-manage={String(canManage)}
      data-enabled={String(enabled)}
      data-testid="tab-body-network-proxy"
    />
  ),
}));

const renderAt = (path: string) => {
  const router = createMemoryRouter(
    [{ element: <SystemGeneralPage />, path: '/admin/system/general' }],
    {
      initialEntries: [path],
    },
  );
  return { ...render(<RouterProvider router={router} />), router };
};

beforeEach(() => {
  mocks.admin.permissions = [
    PLATFORM_PERMISSIONS.SYSTEM_READ,
    PLATFORM_PERMISSIONS.NETWORK_PROXY_READ,
  ];
});

describe('SystemGeneralPage', () => {
  it('defaults to 基础设施 and offers both tabs', () => {
    renderAt('/admin/system/general');
    expect(screen.getByTestId('tab-infrastructure')).toBeTruthy();
    expect(screen.getByTestId('tab-network-proxy')).toBeTruthy();
    expect(screen.getByTestId('tab-body-infrastructure')).toBeTruthy();
  });

  it('honours ?tab=network-proxy on entry', () => {
    renderAt('/admin/system/general?tab=network-proxy');
    expect(screen.getByTestId('tab-body-network-proxy')).toBeTruthy();
    expect(screen.queryByTestId('tab-body-infrastructure')).toBeNull();
  });

  it('falls back to 基础设施 for an unknown tab value', () => {
    renderAt('/admin/system/general?tab=nope');
    expect(screen.getByTestId('tab-body-infrastructure')).toBeTruthy();
  });

  it('writes the active tab into the URL so the view is shareable', () => {
    const { router } = renderAt('/admin/system/general');
    fireEvent.click(screen.getByTestId('tab-network-proxy'));
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBe('network-proxy');
    expect(screen.getByTestId('tab-body-network-proxy')).toBeTruthy();
  });

  it('hides the 网络代理 tab from an admin without NETWORK_PROXY_READ', () => {
    mocks.admin.permissions = [PLATFORM_PERMISSIONS.SYSTEM_READ];
    renderAt('/admin/system/general?tab=network-proxy');
    expect(screen.queryByTestId('tab-network-proxy')).toBeNull();
    expect(screen.getByTestId('tab-body-infrastructure')).toBeTruthy();
  });

  it('opens the 网络代理 tab for an admin who can only read that domain', () => {
    mocks.admin.permissions = [PLATFORM_PERMISSIONS.NETWORK_PROXY_READ];
    renderAt('/admin/system/general');
    expect(screen.getByTestId('tab-body-network-proxy')).toBeTruthy();
  });

  it('passes NETWORK_PROXY_MANAGE down as the write gate', () => {
    mocks.admin.permissions = [
      PLATFORM_PERMISSIONS.NETWORK_PROXY_READ,
      PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE,
    ];
    renderAt('/admin/system/general?tab=network-proxy');
    expect(screen.getByTestId('tab-body-network-proxy').dataset.canManage).toBe('true');
  });

  it('refuses the page when the admin can read neither domain', () => {
    mocks.admin.permissions = [];
    renderAt('/admin/system/general');
    expect(screen.getByText('page.forbidden.desc')).toBeTruthy();
  });
});

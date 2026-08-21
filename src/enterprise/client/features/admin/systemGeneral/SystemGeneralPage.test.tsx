// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import SystemGeneralPage from './SystemGeneralPage';

const mocks = vi.hoisted(() => ({
  admin: { authMethod: 'better-auth', permissions: [] as string[], status: 'allowed' },
  profileMutate: vi.fn(),
  regenerateBrowserProfile: vi.fn(),
  updateBrowserProfile: vi.fn(),
  view: undefined as
    | undefined
    | {
        onProfileRegenerate: () => Promise<void>;
        onProfileSave: (input: unknown) => Promise<void>;
      },
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

vi.mock('@/enterprise/client/services/adminSystem', () => ({
  adminSystemService: {
    regenerateBrowserProfile: mocks.regenerateBrowserProfile,
    updateBrowserProfile: mocks.updateBrowserProfile,
  },
}));

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
    mutate: mocks.profileMutate,
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
  useAdminSandboxSettings: () => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useInfraDependencyProbe: () => ({ busy: {}, results: {}, run: vi.fn() }),
}));

vi.mock('./SystemGeneralPageView', () => ({
  SystemGeneralPageView: (props: {
    onProfileRegenerate: () => Promise<void>;
    onProfileSave: (input: unknown) => Promise<void>;
  }) => {
    mocks.view = props;
    return <div data-testid="tab-body-infrastructure" />;
  },
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
  mocks.view = undefined;
  mocks.profileMutate.mockReset();
  mocks.regenerateBrowserProfile.mockReset();
  mocks.updateBrowserProfile.mockReset();
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

  it('shows the fingerprint the save returned rather than depending on a follow-up read', async () => {
    const saved = { localeId: 'locale-zh-cn-shanghai', revision: 9 };
    mocks.updateBrowserProfile.mockResolvedValue(saved);
    renderAt('/admin/system/general');

    await mocks.view!.onProfileSave({ expectedRevision: 8 });

    // A revalidation that fails transiently would otherwise leave the card holding the previous
    // summary, so a saved choice keeps reading as unsaved and gets written a second time.
    expect(mocks.profileMutate).toHaveBeenCalledWith(saved, { revalidate: false });
  });

  it('shows the fingerprint regenerate returned rather than depending on a follow-up read', async () => {
    const regenerated = { installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', revision: 6 };
    mocks.regenerateBrowserProfile.mockResolvedValue(regenerated);
    renderAt('/admin/system/general');

    await mocks.view!.onProfileRegenerate();

    expect(mocks.profileMutate).toHaveBeenCalledWith(regenerated, { revalidate: false });
  });

  it('refuses the page when the admin can read neither domain', () => {
    mocks.admin.permissions = [];
    renderAt('/admin/system/general');
    expect(screen.getByText('page.forbidden.desc')).toBeTruthy();
  });
});

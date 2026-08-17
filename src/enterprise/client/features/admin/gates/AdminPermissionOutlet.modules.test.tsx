import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformModuleId } from '@/const/platform/modules';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AdminPermissionOutlet from './AdminPermissionOutlet';

const access = {
  permissions: Object.values(PLATFORM_PERMISSIONS) as string[],
  status: 'allowed' as string,
};
let pathname = '/admin/audit/logs';
let disabled = new Set<PlatformModuleId>();
let envDisabledBy: Partial<Record<PlatformModuleId, string>> = {};

/** base-ui's Button needs a motion ConfigProvider no admin page mounts; the surface's copy is
 * what matters here, not the design system's button rendering. */
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: unknown; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children as never}
    </button>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.variable ? `${key}:${String(options.variable)}` : key,
  }),
}));

vi.mock('react-router', async (importOriginal) => ({
  // Keep the real `matchPath` so the catalog lookup under test is the production one.
  ...(await importOriginal<Record<string, unknown>>()),
  Outlet: () => <div>outlet</div>,
  useLocation: () => ({ pathname }),
  useMatches: () => [],
  useNavigate: () => vi.fn(),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => access,
}));

vi.mock('@/enterprise/client/hooks/useModuleEnabled', () => ({
  useDisabledModules: () => disabled,
}));

vi.mock('../modules/useAdminModules', () => ({
  useAdminModules: () => ({ data: { snapshot: { envDisabledBy } } }),
}));

beforeEach(() => {
  access.permissions = Object.values(PLATFORM_PERMISSIONS);
  access.status = 'allowed';
  pathname = '/admin/audit/logs';
  disabled = new Set();
  envDisabledBy = {};
});

describe('AdminPermissionOutlet module degradation', () => {
  it('renders the page normally when the module is on', () => {
    render(<AdminPermissionOutlet />);
    expect(screen.getByText('outlet')).toBeTruthy();
  });

  it('explains a switched-off module instead of 404-ing a registered route', () => {
    disabled = new Set<PlatformModuleId>(['audit']);
    render(<AdminPermissionOutlet />);

    expect(screen.queryByText('outlet')).toBeNull();
    expect(screen.queryByText('notFound.title')).toBeNull();
    expect(screen.getByText('modules.disabledSurface.title')).toBeTruthy();
    // DB-driven: the operator can fix it here, so offer the link.
    expect(screen.getByText('modules.disabledSurface.action')).toBeTruthy();
  });

  it('names the container parameter instead of offering a button that cannot help', () => {
    disabled = new Set<PlatformModuleId>(['audit']);
    envDisabledBy = { audit: 'LOBE_MODULES_DISABLED' };
    render(<AdminPermissionOutlet />);

    expect(screen.queryByText('modules.disabledSurface.action')).toBeNull();
    expect(screen.getByText('modules.disabledSurface.byEnv:LOBE_MODULES_DISABLED')).toBeTruthy();
  });

  it('keeps a permission failure a permission failure, not a module message', () => {
    access.permissions = [];
    disabled = new Set<PlatformModuleId>(['audit']);
    render(<AdminPermissionOutlet />);
    expect(screen.getByText('page.forbidden.title')).toBeTruthy();
  });

  it('does not degrade core surfaces when some other module is off', () => {
    pathname = '/admin/users';
    disabled = new Set<PlatformModuleId>(['audit', 'moderation', 'branding']);
    render(<AdminPermissionOutlet />);
    expect(screen.getByText('outlet')).toBeTruthy();
  });
});

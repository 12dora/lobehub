// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import IdentityProviderPage from './IdentityProviderPage';

const mocks = vi.hoisted(() => ({
  admin: {
    authMethod: 'better-auth' as const,
    permissions: [] as string[],
    status: 'allowed' as const,
  },
  callbacks: {
    data: undefined as { production: string; test: string } | undefined,
    error: undefined as unknown,
    isLoading: false,
    mutate: vi.fn(),
  },
  easyauth: {
    data: undefined as unknown,
    error: undefined as unknown,
    isLoading: false,
    mutate: vi.fn(),
  },
  providers: {
    data: undefined as { items: unknown[] } | undefined,
    error: undefined as unknown,
    isLoading: false,
    mutate: vi.fn(),
  },
  restartLifecycle: {
    accept: vi.fn(),
    attempt: null,
    fail: vi.fn(),
    phase: 'idle' as const,
    retry: vi.fn(),
  },
  runtime: {
    data: undefined as unknown,
    error: undefined as unknown,
    isLoading: false,
    mutate: vi.fn(),
  },
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => mocks.admin,
}));

vi.mock('@/enterprise/client/services/adminIdentityProviders', () => ({
  adminIdentityProvidersService: {
    prepareRestart: vi.fn(),
    requestRestart: vi.fn(),
  },
}));

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  requestAdminReauth: vi.fn(),
}));

vi.mock('../users/modals/openReasonModal', () => ({
  openReasonModal: vi.fn(),
}));

vi.mock('./useIdentityProviderRestartLifecycle', () => ({
  useIdentityProviderRestartLifecycle: () => mocks.restartLifecycle,
}));

vi.mock('./useIdentityProviders', () => ({
  useAuthSnapshotStatus: () => mocks.runtime,
  useEasyauthStatus: () => mocks.easyauth,
  useIdentityProviderCallbacks: () => mocks.callbacks,
  useIdentityProviders: () => mocks.providers,
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, description }: { action?: ReactNode; description?: ReactNode }) => (
    <div role="alert">
      {description}
      {action}
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children, ...rest }: { children?: ReactNode }) => <span {...rest}>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick, ...rest }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
  confirmModal: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({
    actions,
    children,
    title,
  }: {
    actions?: ReactNode;
    children?: ReactNode;
    title?: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      <div data-testid="page-actions">{actions}</div>
      {children}
    </main>
  ),
}));

vi.mock('../primitives/StatusBadge', () => ({ default: () => null }));

vi.mock('./IdentityProviderWizard', () => ({
  default: () => <div data-testid="identity-provider-wizard">wizard</div>,
}));

vi.mock('./IdentityProviderRuntimeCard', () => ({
  default: () => <div data-testid="identity-runtime-status">runtime</div>,
}));

vi.mock('./EasyauthStatusCard', () => ({
  default: () => <div data-testid="easyauth-status-card">easyauth</div>,
}));

const allIdentityPermissions = [
  PLATFORM_PERMISSIONS.IDENTITY_READ,
  PLATFORM_PERMISSIONS.IDENTITY_CREATE,
  PLATFORM_PERMISSIONS.IDENTITY_UPDATE,
  PLATFORM_PERMISSIONS.IDENTITY_TEST,
  PLATFORM_PERMISSIONS.IDENTITY_PUBLISH,
  PLATFORM_PERMISSIONS.OIDC_PUBLISH,
];

const setupGuidanceError = {
  data: {
    errorData: { code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED },
  },
  message: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
};

const genericLoadError = {
  data: {
    errorData: { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT },
  },
  message: 'network failed',
};

describe('IdentityProviderPage rendering rules', () => {
  beforeEach(() => {
    mocks.admin.permissions = [...allIdentityPermissions];
    mocks.admin.status = 'allowed';
    mocks.providers.data = undefined;
    mocks.providers.error = undefined;
    mocks.providers.isLoading = false;
    mocks.providers.mutate = vi.fn();
    mocks.callbacks.data = undefined;
    mocks.callbacks.error = undefined;
    mocks.runtime.data = undefined;
    mocks.runtime.error = undefined;
    mocks.easyauth.data = undefined;
    mocks.easyauth.error = undefined;
    mocks.restartLifecycle.phase = 'idle';
  });

  it('renders only setup guidance for deploy-config list errors (no create, no runtime)', () => {
    mocks.providers.error = setupGuidanceError;
    mocks.runtime.data = {
      active: { allFreshInstancesActive: true, partial: false },
      artifact: { health: 'healthy', source: 'database' },
      instances: [],
      pendingPublished: [],
      pendingRestart: false,
      restart: { supported: true },
      targetIdentityRevision: null,
    };

    render(<IdentityProviderPage />);

    expect(screen.getByTestId('identity-provider-setup-guidance')).toBeTruthy();
    expect(screen.queryByText('identityProviders.actions.create')).toBeNull();
    expect(screen.queryByTestId('identity-runtime-status')).toBeNull();
    expect(screen.queryByTestId('easyauth-status-card')).toBeNull();
    expect(screen.queryByTestId('identity-provider-type-picker')).toBeNull();
    expect(screen.queryByTestId('identity-provider-wizard')).toBeNull();
  });

  it('keeps create flow mounted while the list is loading after a general load error', () => {
    // SWR retry leaves isLoading=true with a prior general error. Header create remains
    // available; entering create must not be blocked by the full-page loading branch.
    mocks.providers.error = genericLoadError;
    mocks.providers.isLoading = true;

    render(<IdentityProviderPage />);

    expect(screen.queryByTestId('identity-provider-setup-guidance')).toBeNull();
    // Full-page loading is shown when not creating.
    expect(screen.getByText('identityProviders.loading')).toBeTruthy();
    expect(screen.queryByTestId('identity-provider-type-picker')).toBeNull();

    // Header create is outside the list-loading branch and must still work.
    fireEvent.click(screen.getByText('identityProviders.actions.create'));

    // creating=true while isLoading=true: columns + type picker stay mounted
    // (pre-fix bug replaced this entire tree with loading-only status text).
    expect(screen.getByTestId('identity-provider-type-picker')).toBeTruthy();
    expect(screen.queryByTestId('identity-provider-setup-guidance')).toBeNull();
  });
});

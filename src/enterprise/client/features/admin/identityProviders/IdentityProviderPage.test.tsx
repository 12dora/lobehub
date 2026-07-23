// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import IdentityProviderPage from './IdentityProviderPage';
import { openIdentityProviderWizardModal } from './openIdentityProviderWizardModal';

const mocks = vi.hoisted(() => ({
  admin: {
    authMethod: 'better-auth' as const,
    permissions: [] as string[],
    status: 'allowed' as const,
  },
  providers: {
    data: undefined as { items: unknown[]; nextCursor?: string | null } | undefined,
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

vi.mock('./openIdentityProviderWizardModal', () => ({
  openIdentityProviderWizardModal: vi.fn(),
}));

vi.mock('./useIdentityProviderRestartLifecycle', () => ({
  useIdentityProviderRestartLifecycle: () => mocks.restartLifecycle,
}));

const cursorStack = vi.hoisted(() => ({
  cursor: undefined as string | undefined,
  goNext: vi.fn((next: string) => {
    cursorStack.cursor = next;
  }),
  goPrevious: vi.fn(),
  hasPrevious: false,
}));

vi.mock('../skills/useCursorPagedList', () => ({
  useCursorStack: () => ({
    cursor: cursorStack.cursor,
    goNext: cursorStack.goNext,
    goPrevious: cursorStack.goPrevious,
    hasPrevious: cursorStack.hasPrevious,
  }),
}));

vi.mock('./useIdentityProviders', () => ({
  useAuthSnapshotStatus: () => mocks.runtime,
  useIdentityProviders: (_enabled: boolean, cursor?: string) => {
    // Expose the cursor the page passes so pagination can be asserted end-to-end.
    (mocks.providers as { listCursor?: string | undefined }).listCursor = cursor;
    return mocks.providers;
  },
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

// Minimal DataTable: renders one activatable button per row so we can assert row-open.
vi.mock('../primitives/DataTable', () => ({
  default: ({
    cursorPagination,
    dataSource,
    onRowActivate,
  }: {
    cursorPagination?: {
      hasNext: boolean;
      hasPrevious: boolean;
      onNext: () => void;
      onPrevious: () => void;
    };
    dataSource?: { displayName: string; id: string }[];
    onRowActivate?: (item: { id: string }) => void;
  }) => (
    <div data-testid="provider-table">
      {(dataSource ?? []).map((item) => (
        <button key={item.id} type="button" onClick={() => onRowActivate?.(item)}>
          {item.displayName}
        </button>
      ))}
      {cursorPagination ? (
        <div data-testid="provider-pager">
          <button
            disabled={!cursorPagination.hasPrevious}
            type="button"
            onClick={cursorPagination.onPrevious}
          >
            previous
          </button>
          <button
            disabled={!cursorPagination.hasNext}
            type="button"
            onClick={cursorPagination.onNext}
          >
            next
          </button>
        </div>
      ) : null}
    </div>
  ),
}));

const openModalMock = vi.mocked(openIdentityProviderWizardModal);

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

const sampleProvider = {
  buttonLabel: 'Sign in with work account',
  displayName: 'Corp SSO',
  id: 'idp-1',
  providerKey: 'corp',
  status: 'draft',
  type: 'generic_oidc',
};

describe('IdentityProviderPage rendering rules', () => {
  beforeEach(() => {
    openModalMock.mockClear();
    mocks.admin.permissions = [...allIdentityPermissions];
    mocks.admin.status = 'allowed';
    mocks.providers.data = undefined;
    mocks.providers.error = undefined;
    mocks.providers.isLoading = false;
    mocks.providers.mutate = vi.fn();
    mocks.runtime.data = undefined;
    mocks.runtime.error = undefined;
    mocks.restartLifecycle.phase = 'idle';
  });

  it('renders only setup guidance for deploy-config list errors (no create, no table)', () => {
    mocks.providers.error = setupGuidanceError;

    render(<IdentityProviderPage />);

    expect(screen.getByTestId('identity-provider-setup-guidance')).toBeTruthy();
    expect(screen.queryByText('identityProviders.actions.create')).toBeNull();
    expect(screen.queryByTestId('provider-table')).toBeNull();
  });

  it('renders the provider table and opens the create modal from "New"', () => {
    mocks.providers.data = { items: [sampleProvider] };

    render(<IdentityProviderPage />);

    expect(screen.getByTestId('provider-table')).toBeTruthy();

    fireEvent.click(screen.getByText('identityProviders.actions.create'));

    expect(openModalMock).toHaveBeenCalledTimes(1);
    expect(openModalMock.mock.calls[0][0].provider).toBeUndefined();
  });

  it('opens the wizard modal in edit mode when a row is activated', () => {
    mocks.providers.data = { items: [sampleProvider] };

    render(<IdentityProviderPage />);

    fireEvent.click(screen.getByText('Corp SSO'));

    expect(openModalMock).toHaveBeenCalledTimes(1);
    expect(openModalMock.mock.calls[0][0].provider).toMatchObject({ id: 'idp-1' });
  });

  it('passes the second page cursor so provider 101+ is administrable', () => {
    const page2Provider = {
      ...sampleProvider,
      displayName: 'Provider 101',
      id: 'idp-101',
    };
    cursorStack.cursor = undefined;
    cursorStack.goNext.mockClear();
    cursorStack.hasPrevious = false;
    mocks.providers.data = {
      items: [sampleProvider],
      nextCursor: 'cursor-page-2',
    };

    const view = render(<IdentityProviderPage />);

    const next = screen.getByText('next') as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(cursorStack.goNext).toHaveBeenCalledWith('cursor-page-2');

    // Remount with advanced cursor + page-2 payload (memoized page ignores prop-less rerender).
    view.unmount();
    cursorStack.cursor = 'cursor-page-2';
    cursorStack.hasPrevious = true;
    mocks.providers.data = {
      items: [page2Provider],
      nextCursor: null,
    };
    render(<IdentityProviderPage />);

    expect(screen.getByText('Provider 101')).toBeTruthy();
    expect((mocks.providers as { listCursor?: string }).listCursor).toBe('cursor-page-2');
    expect((screen.getByText('previous') as HTMLButtonElement).disabled).toBe(false);
  });
});

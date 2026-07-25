// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  listPublishedRevisions: vi.fn(),
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
  // Preserve defaultValue so action labels render when keys are missing.
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => mocks.admin,
}));

vi.mock('@/enterprise/client/services/adminIdentityProviders', () => ({
  adminIdentityProvidersService: {
    listPublishedRevisions: (...args: unknown[]) => mocks.listPublishedRevisions(...args),
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

// Minimal DataTable: row activate + action column cells for Disable/Delete assertions.
vi.mock('../primitives/DataTable', () => ({
  default: ({
    columns,
    cursorPagination,
    dataSource,
    onRowActivate,
  }: {
    columns?: Array<{
      key?: string;
      render?: (
        value: unknown,
        item: { displayName: string; id: string; status?: string },
      ) => ReactNode;
    }>;
    cursorPagination?: {
      hasNext: boolean;
      hasPrevious: boolean;
      onNext: () => void;
      onPrevious: () => void;
    };
    dataSource?: { displayName: string; id: string; status?: string }[];
    onRowActivate?: (item: { id: string }) => void;
  }) => (
    <div data-testid="provider-table">
      {(dataSource ?? []).map((item) => (
        <div data-testid={`provider-row-${item.id}`} key={item.id}>
          <button type="button" onClick={() => onRowActivate?.(item)}>
            {item.displayName}
          </button>
          <div data-testid={`provider-actions-${item.id}`}>
            {columns
              ?.filter((column) => column.key === 'actions')
              .map((column, index) => (
                <div key={column.key ?? index}>{column.render?.(null, item)}</div>
              ))}
          </div>
        </div>
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
  PLATFORM_PERMISSIONS.IDENTITY_DELETE,
  PLATFORM_PERMISSIONS.OIDC_PUBLISH,
];

const setupGuidanceError = {
  data: {
    errorData: { code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED },
  },
  message: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
};

const sampleProvider = {
  activationRevision: null as number | null,
  buttonLabel: 'Sign in with work account',
  displayName: 'Corp SSO',
  id: 'idp-1',
  providerKey: 'corp',
  revision: 1,
  status: 'draft' as string,
  type: 'generic_oidc',
};

describe('IdentityProviderPage rendering rules', () => {
  beforeEach(() => {
    openModalMock.mockClear();
    mocks.listPublishedRevisions.mockReset();
    mocks.listPublishedRevisions.mockResolvedValue([]);
    mocks.admin.permissions = [...allIdentityPermissions];
    mocks.admin.status = 'allowed';
    mocks.providers.data = undefined;
    mocks.providers.error = undefined;
    mocks.providers.isLoading = false;
    mocks.providers.mutate = vi.fn();
    mocks.runtime.data = undefined;
    mocks.runtime.error = undefined;
    mocks.restartLifecycle.phase = 'idle';
    cursorStack.cursor = undefined;
    cursorStack.hasPrevious = false;
  });

  it('renders only setup guidance for deploy-config list errors (no create, no table)', () => {
    mocks.providers.error = setupGuidanceError;

    render(<IdentityProviderPage />);

    expect(screen.getByTestId('identity-provider-setup-guidance')).toBeTruthy();
    expect(screen.queryByText('New')).toBeNull();
    expect(screen.queryByText('identityProviders.actions.create')).toBeNull();
    expect(screen.queryByTestId('provider-table')).toBeNull();
  });

  it('shows the create action and opens the create modal only when no provider exists yet', () => {
    mocks.providers.data = { items: [] };

    render(<IdentityProviderPage />);

    fireEvent.click(screen.getByText('identityProviders.actions.create'));

    expect(openModalMock).toHaveBeenCalledTimes(1);
    expect(openModalMock.mock.calls[0][0].provider).toBeUndefined();
  });

  it('renders the table and withholds create once a provider exists (single login method)', async () => {
    mocks.providers.data = { items: [{ ...sampleProvider, hasPublishedHistory: false }] };

    render(<IdentityProviderPage />);

    expect(screen.getByTestId('provider-table')).toBeTruthy();
    // Single login method: no "New" once one exists — edit the existing row instead.
    expect(screen.queryByText('identityProviders.actions.create')).toBeNull();
    // Server batches history onto list items — no per-row listPublishedRevisions fan-out.
    expect(mocks.listPublishedRevisions).not.toHaveBeenCalled();
  });

  it('opens the wizard modal in edit mode when a row is activated', async () => {
    mocks.providers.data = { items: [{ ...sampleProvider, hasPublishedHistory: false }] };

    render(<IdentityProviderPage />);

    fireEvent.click(screen.getByText('Corp SSO'));

    expect(openModalMock).toHaveBeenCalledTimes(1);
    expect(openModalMock.mock.calls[0][0].provider).toMatchObject({ id: 'idp-1' });
    expect(mocks.listPublishedRevisions).not.toHaveBeenCalled();
  });

  it('passes the second page cursor so provider 101+ is administrable', async () => {
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
    expect(mocks.listPublishedRevisions).not.toHaveBeenCalled();
  });

  it('offers Delete for never-published drafts and Disable after publish→edit/clear', async () => {
    // Phase 1: never-published draft (activationRevision null, server says no history).
    mocks.providers.data = {
      items: [
        {
          ...sampleProvider,
          activationRevision: null,
          displayName: 'Never published',
          hasPublishedHistory: false,
          id: 'idp-never',
          revision: 0,
          status: 'draft',
        },
      ],
    };

    const view = render(<IdentityProviderPage />);

    await waitFor(() => {
      expect(screen.getByText('identityProviders.actions.delete')).toBeTruthy();
    });
    expect(screen.queryByText('Disable')).toBeNull();
    expect(mocks.listPublishedRevisions).not.toHaveBeenCalled();

    // Phase 2: same provider after publish → edit/secret-clear. Head is draft with
    // activationRevision=null, but published revision history still exists (live prior config).
    view.unmount();
    mocks.providers.data = {
      items: [
        {
          ...sampleProvider,
          activationRevision: null,
          displayName: 'Edited after publish',
          hasPublishedHistory: true,
          id: 'idp-edited',
          revision: 3,
          status: 'draft',
        },
      ],
    };

    render(<IdentityProviderPage />);

    await waitFor(() => {
      expect(screen.getByText('Disable')).toBeTruthy();
    });
    expect(screen.queryByText('identityProviders.actions.delete')).toBeNull();
    expect(mocks.listPublishedRevisions).not.toHaveBeenCalled();
  });

  it('keeps Disable (not Delete) when published-history is unknown on the list item', async () => {
    // Older payloads / missing field → unknown → fail safe toward revocation.
    mocks.providers.data = {
      items: [
        {
          ...sampleProvider,
          activationRevision: null,
          displayName: 'Compromised IdP',
          id: 'idp-compromised',
          revision: 4,
          status: 'draft',
        },
      ],
    };

    render(<IdentityProviderPage />);

    await waitFor(() => {
      expect(screen.getByText('Disable')).toBeTruthy();
    });
    expect(screen.queryByText('identityProviders.actions.delete')).toBeNull();
    expect(mocks.listPublishedRevisions).not.toHaveBeenCalled();
  });

  it('does not fan out per-row history requests for a full draft page', async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      ...sampleProvider,
      displayName: `Draft ${index}`,
      hasPublishedHistory: index % 2 === 0,
      id: `idp-${index}`,
      providerKey: `draft-${index}`,
      status: 'draft' as const,
    }));
    mocks.providers.data = { items, nextCursor: null };

    render(<IdentityProviderPage />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-table')).toBeTruthy();
    });
    expect(mocks.listPublishedRevisions).not.toHaveBeenCalled();
  });
});

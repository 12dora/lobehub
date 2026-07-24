// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AgentListPage from './AgentListPage';
import type { AdminAgentListItem } from './types';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: {} as Record<string, unknown>,
  openCreate: vi.fn(),
  openDelete: vi.fn(),
  permissions: [] as string[],
  refresh: vi.fn(),
  removeItem: vi.fn(),
  toastError: vi.fn(),
}));

// NOTE: AsyncBoundary is intentionally NOT mocked — this exercises its real
// loading → error → empty → data precedence against the hook's settled signal.
vi.mock('antd-style', () => ({
  createStaticStyles: (
    factory: (helpers: { css: (s: TemplateStringsArray) => string }) => Record<string, string>,
  ) => factory({ css: (s) => String(s.join('')) }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'password', permissions: mocks.permissions }),
}));
vi.mock('./useAdminAgents', () => ({
  useAdminAgentListPagination: () => mocks.list,
}));
vi.mock('./openCreateAgentModal', () => ({
  openCreateAgentModal: (...args: unknown[]) => mocks.openCreate(...args),
}));
vi.mock('./openDeleteAgentModal', () => ({
  openDeleteAgentModal: (...args: unknown[]) => mocks.openDelete(...args),
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {
    get: (...args: unknown[]) => mocks.get(...args),
  },
}));
vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: () => <div role="status">loading</div>,
}));
vi.mock('@/components/NeuralNetworkLoading', () => ({
  default: () => <div role="status">loading</div>,
}));
vi.mock('@/components/AsyncError', () => ({
  default: ({ onRetry }: { onRetry?: () => void }) => (
    <div role="alert">
      error<button onClick={onRetry}>retry</button>
    </div>
  ),
}));
vi.mock('@lobehub/ui', () => ({
  Center: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Empty: ({ action, description }: { action?: ReactNode; description?: ReactNode }) => (
    <div>
      {description}
      {action}
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Input: (props: any) => <input {...props} />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Select: (props: any) => (
    <select
      aria-label={props['aria-label']}
      value={props.value ?? ''}
      onChange={(event) => props.onChange?.(event.target.value || undefined)}
    >
      <option value="">—</option>
      {(props.options ?? []).map((option: { label: string; value: string }) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  toast: { error: (...args: unknown[]) => mocks.toastError(...args), success: vi.fn() },
}));
vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ actions, children, toolbar }: any) => (
    <main>
      {actions}
      {toolbar}
      {children}
    </main>
  ),
}));
vi.mock('../primitives/DataTable', () => ({
  default: ({
    columns,
    dataSource,
  }: {
    columns: Array<{ key?: string; render?: (v: unknown, item: AdminAgentListItem) => ReactNode }>;
    dataSource: AdminAgentListItem[];
  }) => (
    <div>
      <div>rows:{dataSource.length}</div>
      {dataSource.map((item) => (
        <div key={item.identity.id}>
          {columns.map((column) => (
            <div key={column.key}>{column.render?.(undefined, item)}</div>
          ))}
        </div>
      ))}
    </div>
  ),
}));
vi.mock('../primitives/StatusBadge', () => ({ default: () => <span>status</span> }));

const item = (id: string, over: Partial<AdminAgentListItem['identity']> = {}): AdminAgentListItem =>
  ({
    assignmentCount: 0,
    displayName: id,
    identity: { agentKey: id, id, isDefault: false, systemKey: null, status: 'draft', ...over },
    publishedVersion: null,
  }) as never;

const pagination = (over: Record<string, unknown>) => ({
  boundaryData: undefined,
  error: undefined,
  hasMore: false,
  isEmpty: false,
  isLoadingInitial: false,
  isLoadingMore: false,
  items: [],
  loadMore: vi.fn(),
  loadMoreError: false,
  refresh: mocks.refresh,
  removeItem: mocks.removeItem,
  retry: vi.fn(),
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <AgentListPage />
    </MemoryRouter>,
  );

describe('AgentListPage with the real AsyncBoundary', () => {
  beforeEach(() => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ];
    mocks.list = pagination({});
    mocks.openCreate.mockReset();
    mocks.openDelete.mockReset();
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    mocks.removeItem.mockReset().mockResolvedValue(undefined);
    mocks.get.mockReset();
    mocks.toastError.mockReset();
  });

  it('shows the real loading state before the first page settles (data undefined)', () => {
    mocks.list = pagination({ boundaryData: undefined, isLoadingInitial: true });
    renderPage();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.list.empty.default')).toBeNull();
  });

  it('renders the initial-fetch error (not empty) when the first page fails', () => {
    mocks.list = pagination({ boundaryData: undefined, error: new Error('offline') });
    renderPage();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.list.empty.default')).toBeNull();
  });

  it('shows the empty state only after a settled empty page', () => {
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    renderPage();
    expect(screen.getByText('agentCatalog.list.empty.default')).toBeTruthy();
  });

  it('offers a clear-filters action for a settled filtered empty result', () => {
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    render(
      <MemoryRouter initialEntries={['/admin/agents?q=missing']}>
        <AgentListPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('agentCatalog.list.empty.filtered')).toBeTruthy();
    expect(screen.getByText('primitives.filterBar.clear')).toBeTruthy();
  });

  it('renders rows and a load-more control when more pages remain', () => {
    mocks.list = pagination({ boundaryData: [item('a')], hasMore: true, items: [item('a')] });
    renderPage();
    expect(screen.getByText('rows:1')).toBeTruthy();
    expect(screen.getByText('agentCatalog.list.loadMore')).toBeTruthy();
  });

  it('keeps content and shows an inline retry when a later page fails', () => {
    mocks.list = pagination({
      boundaryData: [item('a')],
      items: [item('a')],
      loadMoreError: true,
    });
    renderPage();
    expect(screen.getByText('rows:1')).toBeTruthy();
    expect(screen.getByText('agentCatalog.list.loadMoreError')).toBeTruthy();
  });

  it('does not expose create to a read-only auditor', () => {
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    renderPage();
    expect(screen.queryByText('agentCatalog.create.submit')).toBeNull();
  });

  it('keeps search input, status filter, and Search button inside one toolbar', () => {
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    renderPage();
    const toolbar = screen.getByTestId('agent-list-toolbar');
    expect(toolbar.querySelector('input')).toBeTruthy();
    expect(toolbar.querySelector('select')).toBeTruthy();
    expect(toolbar).toHaveTextContent('agentCatalog.list.applySearch');
    // Explicit Search control lives in the toolbar (not a second stacked row outside it).
    expect(
      screen
        .getByText('agentCatalog.list.applySearch')
        .closest('[data-testid="agent-list-toolbar"]'),
    ).toBe(toolbar);
  });

  it('refreshes the bound infinite list after a successful delete via removeItem', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.get.mockResolvedValue({
      draftToken: 'a'.repeat(64),
      identity: {
        agentKey: 'agent-1',
        draftSequence: 0,
        id: 'agent-1',
        isDefault: false,
        migrationRequired: false,
        revision: 3,
        status: 'draft',
        systemKey: null,
      },
    });
    mocks.list = pagination({
      boundaryData: [item('agent-1')],
      items: [item('agent-1')],
    });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.delete.action'));
    // List delete fetches authoritative CAS before opening the modal.
    await waitFor(() =>
      expect(mocks.openDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          displayName: 'agent-1',
          expectedDraftToken: 'a'.repeat(64),
          expectedRevision: 3,
        }),
      ),
    );
    expect(mocks.get).toHaveBeenCalledWith({ id: 'agent-1' });
    const { onDeleted } = mocks.openDelete.mock.calls[0]![0] as {
      onDeleted: () => void | Promise<void>;
    };
    await onDeleted();
    // Committed delete drops the row from bound pages (not a bare revalidate that can leave it).
    expect(mocks.removeItem).toHaveBeenCalledWith('agent-1');
  });

  it('surfaces a localized preflight failure without opening the delete modal', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.get.mockRejectedValue(new Error('offline'));
    mocks.list = pagination({
      boundaryData: [item('agent-1')],
      items: [item('agent-1')],
    });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.delete.action'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.openDelete).not.toHaveBeenCalled();
    // Row remains — preflight never committed a delete.
    expect(screen.getByText('rows:1')).toBeTruthy();
  });

  it('still invokes removeItem when post-delete revalidation rejects', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.get.mockResolvedValue({
      draftToken: 'a'.repeat(64),
      identity: {
        agentKey: 'agent-1',
        draftSequence: 0,
        id: 'agent-1',
        isDefault: false,
        migrationRequired: false,
        revision: 3,
        status: 'draft',
        systemKey: null,
      },
    });
    // removeItem optimistically drops then revalidates; revalidation failure must still resolve
    // the optimistic drop path (caller catches at openDeleteAgentModal).
    mocks.removeItem.mockRejectedValueOnce(new Error('revalidate failed'));
    mocks.list = pagination({
      boundaryData: [item('agent-1')],
      items: [item('agent-1')],
    });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.delete.action'));
    await waitFor(() => expect(mocks.openDelete).toHaveBeenCalled());
    const { onDeleted } = mocks.openDelete.mock.calls[0]![0] as {
      onDeleted: () => void | Promise<void>;
    };
    await expect(onDeleted()).rejects.toThrow('revalidate failed');
    expect(mocks.removeItem).toHaveBeenCalledWith('agent-1');
  });

  it('refreshes the bound infinite list after create before navigating', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_CREATE];
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    renderPage();

    // Header action and empty-state CTA share the same label — either path uses the same callback.
    fireEvent.click(screen.getAllByText('agentCatalog.create.submit')[0]!);
    expect(mocks.openCreate).toHaveBeenCalledOnce();
    const onCreated = mocks.openCreate.mock.calls[0]![0] as (id: string) => Promise<void>;
    await onCreated('new-agent');
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  });
});

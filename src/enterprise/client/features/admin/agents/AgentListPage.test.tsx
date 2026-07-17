// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AgentListPage from './AgentListPage';
import type { AdminAgentListItem } from './types';

const mocks = vi.hoisted(() => ({
  list: {} as Record<string, unknown>,
  permissions: [] as string[],
}));

// NOTE: AsyncBoundary is intentionally NOT mocked — this exercises its real
// loading → error → empty → data precedence against the hook's settled signal.
vi.mock('antd-style', () => ({ createStaticStyles: () => ({ identity: '' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ permissions: mocks.permissions }),
}));
vi.mock('./useAdminAgents', () => ({
  refreshAdminAgentLists: vi.fn(),
  useAdminAgentListPagination: () => mocks.list,
}));
vi.mock('./openCreateAgentModal', () => ({ openCreateAgentModal: vi.fn() }));
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
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Input: (props: any) => <input {...props} />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Select: () => <select />,
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
  default: ({ dataSource }: { dataSource: AdminAgentListItem[] }) => (
    <div>rows:{dataSource.length}</div>
  ),
}));
vi.mock('../primitives/StatusBadge', () => ({ default: () => <span>status</span> }));

const item = (id: string): AdminAgentListItem =>
  ({
    assignmentCount: 0,
    displayName: id,
    identity: { agentKey: id, id },
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
});

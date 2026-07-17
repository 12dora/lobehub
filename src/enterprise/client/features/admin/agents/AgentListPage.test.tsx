// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AgentListPage from './AgentListPage';

const mocks = vi.hoisted(() => ({
  list: {
    error: undefined as unknown,
    hasMore: false,
    isEmpty: false,
    isLoadingInitial: false,
    isLoadingMore: false,
    items: [] as unknown[],
    loadMore: vi.fn(),
    retry: vi.fn(),
  },
  permissions: [] as string[],
}));

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
vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children, empty, error, isEmpty, isLoading }: any) => {
    if (isLoading) return <div role="status">loading</div>;
    if (error) return <div role="alert">error</div>;
    if (isEmpty) return <div>{empty}</div>;
    return children;
  },
}));
vi.mock('@/components/Loading/BrandTextLoading', () => ({ default: () => <div>loader</div> }));
vi.mock('@lobehub/ui', () => ({
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
vi.mock('../primitives/DataTable', () => ({ default: () => <div>table-data</div> }));
vi.mock('../primitives/StatusBadge', () => ({ default: () => <span>status</span> }));

describe('AgentListPage state precedence', () => {
  beforeEach(() => {
    mocks.list = {
      error: undefined,
      hasMore: false,
      isEmpty: false,
      isLoadingInitial: false,
      isLoadingMore: false,
      items: [],
      loadMore: vi.fn(),
      retry: vi.fn(),
    };
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ];
  });

  it('renders first-load error instead of the empty state', () => {
    mocks.list.error = new Error('offline');
    render(
      <MemoryRouter>
        <AgentListPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toBe('error');
    expect(screen.queryByText('agentCatalog.list.empty.default')).toBeNull();
  });

  it('shows a real empty state only after a settled empty response', () => {
    mocks.list.isEmpty = true;
    render(
      <MemoryRouter>
        <AgentListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('agentCatalog.list.empty.default')).toBeTruthy();
  });

  it('surfaces a load-more control while more pages remain', () => {
    mocks.list.items = [{ identity: { id: 'a' } }];
    mocks.list.hasMore = true;
    render(
      <MemoryRouter>
        <AgentListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('agentCatalog.list.loadMore')).toBeTruthy();
  });

  it('does not expose create to a read-only auditor', () => {
    mocks.list.isEmpty = true;
    render(
      <MemoryRouter>
        <AgentListPage />
      </MemoryRouter>,
    );
    expect(screen.queryByText('agentCatalog.create.submit')).toBeNull();
  });
});

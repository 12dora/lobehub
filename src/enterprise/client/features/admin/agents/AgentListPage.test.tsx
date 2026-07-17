// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AgentListPage from './AgentListPage';

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  error: undefined as unknown,
  isLoading: false,
  mutate: vi.fn(),
  permissions: ['platform_agent:read:all'] as string[],
}));

vi.mock('antd-style', () => ({ createStaticStyles: () => ({ identity: '' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ permissions: mocks.permissions }),
}));
vi.mock('./useAdminAgents', () => ({
  refreshAdminAgentLists: vi.fn(),
  useFetchAdminAgents: () => ({
    data: mocks.data,
    error: mocks.error,
    isLoading: mocks.isLoading,
    mutate: mocks.mutate,
  }),
}));
vi.mock('./openCreateAgentModal', () => ({ openCreateAgentModal: vi.fn() }));
vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children, data, empty, error, isEmpty, isLoading }: any) => {
    if (isLoading && data === undefined) return <div role="status">loading</div>;
    if (error && data === undefined) return <div role="alert">error</div>;
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
    mocks.data = undefined;
    mocks.error = undefined;
    mocks.isLoading = false;
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ];
  });

  it('renders first-load error instead of the empty state', () => {
    mocks.error = new Error('offline');
    render(
      <MemoryRouter>
        <AgentListPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toBe('error');
    expect(screen.queryByText('agentCatalog.list.empty.default')).toBeNull();
  });

  it('shows a real empty state only after a settled empty response', () => {
    mocks.data = { items: [] };
    render(
      <MemoryRouter>
        <AgentListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('agentCatalog.list.empty.default')).toBeTruthy();
  });

  it('does not expose create to a read-only auditor', () => {
    mocks.data = { items: [] };
    render(
      <MemoryRouter>
        <AgentListPage />
      </MemoryRouter>,
    );
    expect(screen.queryByText('agentCatalog.create.submit')).toBeNull();
  });
});

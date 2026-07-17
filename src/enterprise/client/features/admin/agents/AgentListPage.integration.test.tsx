// @vitest-environment happy-dom
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AgentListPage from './AgentListPage';
import type { AdminAgentListItem } from './types';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

// Real hook + real SWR + real AsyncBoundary. Only the service and heavy leaf UI are stubbed.
vi.mock('antd-style', () => ({ createStaticStyles: () => ({ identity: '' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ permissions: [PLATFORM_PERMISSIONS.AGENT_READ] }),
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: { capabilities: { rollouts: false }, list: mocks.list },
}));
vi.mock('./openCreateAgentModal', () => ({ openCreateAgentModal: vi.fn() }));
vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: () => <div role="status">loading</div>,
}));
vi.mock('@/components/NeuralNetworkLoading', () => ({
  default: () => <div role="status">loading</div>,
}));
vi.mock('@/components/AsyncError', () => ({ default: () => <div role="alert">error</div> }));
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const renderPage = () =>
  render(
    <SWRConfig
      value={{ dedupingInterval: 0, provider: () => new Map(), shouldRetryOnError: false }}
    >
      <MemoryRouter>
        <AgentListPage />
      </MemoryRouter>
    </SWRConfig>,
  );

describe('AgentListPage end-to-end through real SWR + AsyncBoundary', () => {
  beforeEach(() => mocks.list.mockReset());

  it('shows loading before the first page settles, then the rows', async () => {
    const first = deferred<{ items: AdminAgentListItem[]; nextCursor: string | null }>();
    mocks.list.mockReturnValueOnce(first.promise);
    renderPage();

    expect(screen.getByRole('status')).toBeTruthy();

    await act(async () => {
      first.resolve({ items: [item('a')], nextCursor: null });
    });
    await waitFor(() => expect(screen.getByText('rows:1')).toBeTruthy());
  });

  it('renders the error state (not empty) when the first fetch rejects', async () => {
    const first = deferred<{ items: AdminAgentListItem[]; nextCursor: string | null }>();
    mocks.list.mockReturnValueOnce(first.promise);
    renderPage();

    await act(async () => {
      first.reject(new Error('offline'));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText('agentCatalog.list.empty.default')).toBeNull();
  });

  it('renders the empty state after a settled empty page', async () => {
    const first = deferred<{ items: AdminAgentListItem[]; nextCursor: string | null }>();
    mocks.list.mockReturnValueOnce(first.promise);
    renderPage();

    await act(async () => {
      first.resolve({ items: [], nextCursor: null });
    });
    await waitFor(() => expect(screen.getByText('agentCatalog.list.empty.default')).toBeTruthy());
  });
});

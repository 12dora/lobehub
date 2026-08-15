// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AgentDetailPage from './AgentDetailPage';

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  error: undefined as unknown,
  isLoading: false,
  mutate: vi.fn(),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ permissions: [PLATFORM_PERMISSIONS.AGENT_READ] }),
}));
vi.mock('@/enterprise/client/providers/EnterprisePlatformProvider', () => ({
  useEnterprisePlatform: () => ({
    capabilities: { managedResources: { agents: false } },
  }),
}));
vi.mock('./useAdminAgents', () => ({
  useFetchAdminAgent: () => ({
    data: mocks.data,
    error: mocks.error,
    isLoading: mocks.isLoading,
    mutate: mocks.mutate,
    retryRolloutPoll: vi.fn(),
    rolloutPollError: undefined,
  }),
}));
vi.mock('./AgentDetailView', () => ({
  AgentDetailView: ({ snapshot }: { snapshot: { identity: { id: string } } }) => (
    <div>agent-detail-data:{snapshot.identity.id}</div>
  ),
}));
vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children, data, error, isLoading }: any) => {
    if (isLoading && data === undefined) return <div role="status">loading</div>;
    if (error && data === undefined) return <div role="alert">generic-error</div>;
    return children;
  },
}));
vi.mock('@/components/Loading/BrandTextLoading', () => ({ default: () => <div>loader</div> }));
vi.mock('../pages/AdminStateSurfaces', () => ({
  AdminNotFoundSurface: () => <div>agent-not-found</div>,
}));

const agent = (id: string) => ({
  assignments: [],
  draftToken: 'a'.repeat(64),
  identity: {
    agentKey: id,
    currentVersionId: null,
    draftSequence: 0,
    id,
    isDefault: false,
    migrationRequired: false,
    revision: 1,
    status: 'published' as const,
    systemKey: null,
  },
  rollouts: [],
  versions: [],
});

const renderPage = (id = 'agent-1') =>
  render(
    <MemoryRouter initialEntries={[`/admin/agents/${id}`]}>
      <Routes>
        <Route element={<AgentDetailPage />} path="/admin/agents/:id" />
      </Routes>
    </MemoryRouter>,
  );

describe('AgentDetailPage state precedence', () => {
  beforeEach(() => {
    mocks.data = undefined;
    mocks.error = undefined;
    mocks.isLoading = false;
  });

  it('separates structured not-found from generic failures', () => {
    mocks.error = new Error('PLATFORM_NOT_FOUND');
    renderPage();
    expect(screen.getByText('agent-not-found')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders a generic first-load error with no false data surface', () => {
    mocks.error = new Error('offline');
    renderPage();
    expect(screen.getByRole('alert').textContent).toBe('generic-error');
    expect(screen.queryByText(/agent-detail-data/)).toBeNull();
  });

  it('renders loading before any settled data', () => {
    mocks.isLoading = true;
    renderPage();
    expect(screen.getByRole('status').textContent).toBe('loading');
  });

  it('renders the detail once the snapshot matches the route agent id', () => {
    mocks.data = agent('agent-B');
    renderPage('agent-B');
    expect(screen.getByText('agent-detail-data:agent-B')).toBeTruthy();
  });

  it('rejects a retained previous-agent snapshot under a new agent URL', () => {
    mocks.data = agent('agent-A');
    renderPage('agent-B');
    expect(screen.queryByText(/agent-detail-data/)).toBeNull();
  });

  it('prunes the legacy local drafts when the detail page is opened directly', () => {
    // A bookmarked detail URL is an entry point too: the list may never be visited, and the old
    // recovery drafts (with their prompts) must not survive in localStorage because of that.
    localStorage.setItem('aihub.admin.agents.draft.agent-B', '{"draft":{}}');
    localStorage.setItem('unrelated', 'keep');
    mocks.data = agent('agent-B');

    renderPage('agent-B');

    expect(localStorage.getItem('aihub.admin.agents.draft.agent-B')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('after A→B navigation, a B load failure does not paint retained A detail under B', () => {
    // Route is B, fetch of B failed, SWR has no keepPreviousData — must not render A under B's URL.
    mocks.data = undefined;
    mocks.error = new Error('offline');
    renderPage('agent-B');
    expect(screen.queryByText(/agent-detail-data/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('generic-error');
  });
});

// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AgentDetailPage from './AgentDetailPage';

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  editorBaselineAgentId: undefined as string | undefined,
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
vi.mock('./useAgentEditor', () => ({
  useAgentEditor: () => ({
    draftBaseline: mocks.editorBaselineAgentId
      ? { agentId: mocks.editorBaselineAgentId, draftToken: 'a'.repeat(64), revision: 1 }
      : null,
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
    status: 'draft' as const,
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
    mocks.editorBaselineAgentId = undefined;
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

  it('withholds the detail view during an A→B identity transition until the editor matches B', () => {
    // Route is agent-B, SWR already has B's snapshot, but the editor still holds A's baseline
    // (hydration effect not run yet / previous agent retained). Must not paint B with A's editor.
    mocks.data = agent('agent-B');
    mocks.editorBaselineAgentId = 'agent-A';
    renderPage('agent-B');
    expect(screen.getByRole('status').textContent).toBe('loading');
    expect(screen.queryByText(/agent-detail-data/)).toBeNull();
  });

  it('renders only when matched snapshot and editor baseline share the route agent id', () => {
    mocks.data = agent('agent-B');
    mocks.editorBaselineAgentId = 'agent-B';
    renderPage('agent-B');
    expect(screen.getByText('agent-detail-data:agent-B')).toBeTruthy();
  });

  it('rejects a retained previous-agent snapshot under a new agent URL', () => {
    mocks.data = agent('agent-A');
    mocks.editorBaselineAgentId = 'agent-A';
    renderPage('agent-B');
    expect(screen.queryByText(/agent-detail-data/)).toBeNull();
  });

  it('after A→B navigation, a B load failure does not paint retained A detail under B', () => {
    // Route is B, fetch of B failed, SWR has no keepPreviousData — must not render A under B's URL.
    mocks.data = undefined;
    mocks.error = new Error('offline');
    mocks.editorBaselineAgentId = 'agent-A';
    renderPage('agent-B');
    expect(screen.queryByText(/agent-detail-data/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('generic-error');
  });
});

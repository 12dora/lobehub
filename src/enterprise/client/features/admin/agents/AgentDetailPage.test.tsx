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
vi.mock('./useAdminAgents', () => ({
  useFetchAdminAgent: () => ({
    data: mocks.data,
    error: mocks.error,
    isLoading: mocks.isLoading,
    mutate: mocks.mutate,
  }),
}));
vi.mock('./useAgentEditor', () => ({ useAgentEditor: () => ({}) }));
vi.mock('./AgentDetailView', () => ({ AgentDetailView: () => <div>agent-detail-data</div> }));
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/agents/agent-1']}>
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
    expect(screen.queryByText('agent-detail-data')).toBeNull();
  });

  it('renders loading before any settled data', () => {
    mocks.isLoading = true;
    renderPage();
    expect(screen.getByRole('status').textContent).toBe('loading');
  });
});

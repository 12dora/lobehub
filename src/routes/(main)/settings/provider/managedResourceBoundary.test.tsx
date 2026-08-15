import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import WorkspaceProviderSetting from '@/routes/(main)/[workspaceSlug]/settings/provider';
import MobileProviderLayout from '@/routes/(mobile)/settings/provider/_layout';

import ProviderListPage from './(list)';

// Stub the boundary so the assertion is structural: if a route renders the marker and NOTHING
// else, the boundary really wraps that route's whole tree (under 平台托管 the boundary swaps the
// children for ManagedResourceNotice, so anything rendered outside it stays editable).
vi.mock('@/features/ManagedResources', () => ({
  ManagedResourceBoundary: ({ resource }: { resource: string }) => (
    <div data-resource={resource} data-testid="managed-resource-boundary" />
  ),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

const renderRoute = (element: React.ReactElement) =>
  render(<MemoryRouter initialEntries={['/settings/provider']}>{element}</MemoryRouter>);

describe('provider settings routes are managed-resource boundaried', () => {
  it.each([
    ['bare (list) route', <ProviderListPage key="list" />],
    ['workspace provider settings', <WorkspaceProviderSetting key="workspace" />],
    ['mobile provider layout', <MobileProviderLayout key="mobile" />],
  ])('%s blocks under 平台托管', (_label, element) => {
    const { container } = renderRoute(element);

    const boundary = screen.getByTestId('managed-resource-boundary');
    expect(boundary.getAttribute('data-resource')).toBe('aiProviders');
    // Nothing renders outside the boundary.
    expect(container.querySelectorAll('[data-testid]')).toHaveLength(1);
  });
});

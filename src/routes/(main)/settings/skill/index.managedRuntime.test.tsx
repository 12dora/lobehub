// @vitest-environment happy-dom
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToolStore } from '@/store/tool';

import { ToolSettings } from './index';

vi.mock('@/features/NavHeader', () => ({ default: () => null }));
vi.mock('@/features/ManagedResources', () => ({
  ManagedResourceNotice: () => null,
  useManagedResource: () => ({ error: null, loading: false, managed: true, refresh: vi.fn() }),
}));
vi.mock('./features/LeftPanel', () => ({
  default: ({ selectedIdentifier }: { selectedIdentifier?: string }) => (
    <span data-testid="selected">{selectedIdentifier ?? ''}</span>
  ),
}));
vi.mock('./features/SkillDetail', () => ({
  default: ({ identifier }: { identifier: string }) => <span>{identifier}</span>,
}));

const LocationProbe = () => {
  const location = useLocation();
  return <span data-testid="location">{location.search}</span>;
};

const renderSettings = (children?: ReactNode) =>
  render(
    <MemoryRouter initialEntries={['/settings/skill?skill=target.skill&page=3']}>
      <ToolSettings managed viewMode="skill" />
      <LocationProbe />
      {children}
    </MemoryRouter>,
  );

describe('ToolSettings managed runtime lifecycle', () => {
  beforeEach(() => {
    useToolStore.setState({
      agentSkills: [],
      builtinSkills: [],
      builtinTools: [],
      platformSkillCatalog: null,
      platformSkillRuntimeManaged: true,
      platformSkillRuntimeStatus: 'loading',
    });
  });

  it('preserves a deep-link selection through loading/error and restores it only after ready', async () => {
    renderSettings();

    expect(screen.getByTestId('location')).toHaveTextContent('skill=target.skill');
    expect(screen.getByTestId('location')).toHaveTextContent('page=3');
    expect(screen.getByTestId('selected')).toHaveTextContent('');

    act(() => useToolStore.setState({ platformSkillRuntimeStatus: 'error' }));
    expect(screen.getByTestId('location')).toHaveTextContent('skill=target.skill');
    expect(screen.getByTestId('selected')).toHaveTextContent('');

    act(() =>
      useToolStore.setState({
        platformSkillCatalog: {
          revision: 'catalog-1',
          skills: [
            {
              checksum: 'a'.repeat(64),
              description: 'Target',
              displayName: 'Target',
              distribution: 'optional',
              skillKey: 'target.skill',
              source: 'uploaded',
              version: '1.0.0',
            },
          ],
        },
        platformSkillRuntimeStatus: 'ready',
      }),
    );

    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent('target.skill'));
    expect(screen.getByTestId('location')).toHaveTextContent('skill=target.skill');
    expect(screen.getByTestId('location')).toHaveTextContent('page=3');
  });
});

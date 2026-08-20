/**
 * @vitest-environment happy-dom
 */
import { INBOX_SESSION_ID } from '@lobechat/const';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '@/store/agent';
import { useHomeStore } from '@/store/home';

import Agent from './index';

const route = vi.hoisted(() => ({ pathname: '/agent/agent-1' }));

vi.mock('react-router', () => ({
  useLocation: () => ({ pathname: route.pathname }),
}));

vi.mock('./SwitchPanel', () => ({
  default: ({ children }: { children?: ReactNode }) => (
    <div data-testid="agent-chip">{children}</div>
  ),
}));

vi.mock('@/features/NavPanel/components/SkeletonList', () => ({
  SkeletonItem: () => <div data-testid="agent-chip-skeleton" />,
}));

vi.mock('@/hooks/useDefaultInboxDisplayName', () => ({
  useDefaultInboxDisplayName: (title?: string | null) => title || 'Inbox Fallback',
}));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: () => null,
  Avatar: ({ avatar }: { avatar?: string }) => <div data-testid="agent-chip-avatar">{avatar}</div>,
  Block: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

const resetStores = () => {
  useAgentStore.setState(
    { activeAgentId: undefined, agentConfigErrorMap: {}, agentMap: {}, builtinAgentIdMap: {} },
    false,
  );
  useHomeStore.setState(
    {
      agentGroups: [],
      pinnedAgents: [],
      privateAgentGroups: [],
      privateUngroupedAgents: [],
      ungroupedAgents: [],
    },
    false,
  );
};

const sidebarItem = (id: string, title: string) => ({
  id,
  pinned: false,
  title,
  type: 'agent' as const,
  updatedAt: new Date(),
});

describe('agent sidebar identity chip', () => {
  beforeEach(() => {
    route.pathname = '/agent/agent-1';
    resetStores();
  });

  it('renders the routed agent even when activeAgentId is stale/undefined', () => {
    useAgentStore.setState(
      { activeAgentId: undefined, agentMap: { 'agent-1': { id: 'agent-1', title: 'Routed' } } },
      false,
    );

    render(<Agent />);

    expect(screen.queryByTestId('agent-chip-skeleton')).not.toBeInTheDocument();
    expect(screen.getByText('Routed')).toBeInTheDocument();
  });

  it('does not follow a stale activeAgentId from the previous route', () => {
    useAgentStore.setState(
      {
        activeAgentId: 'other-agent',
        agentMap: {
          'agent-1': { id: 'agent-1', title: 'Routed' },
          'other-agent': { id: 'other-agent', title: 'Stale Inbox' },
        },
      },
      false,
    );

    render(<Agent />);

    expect(screen.getByText('Routed')).toBeInTheDocument();
    expect(screen.queryByText('Stale Inbox')).not.toBeInTheDocument();
  });

  it('falls back to the sidebar list meta before the config lands', () => {
    useHomeStore.setState({ ungroupedAgents: [sidebarItem('agent-1', 'From List')] }, false);

    render(<Agent />);

    expect(screen.queryByTestId('agent-chip-skeleton')).not.toBeInTheDocument();
    expect(screen.getByText('From List')).toBeInTheDocument();
  });

  it('finds the sidebar list meta inside a group folder', () => {
    useHomeStore.setState(
      {
        agentGroups: [
          { id: 'g1', items: [sidebarItem('agent-1', 'Grouped')], name: 'Group', sort: 0 },
        ],
      },
      false,
    );

    render(<Agent />);

    expect(screen.getByText('Grouped')).toBeInTheDocument();
  });

  it('never spins forever when the config fetch failed', () => {
    useAgentStore.setState(
      { activeAgentId: undefined, agentConfigErrorMap: { 'agent-1': 'Forbidden' } },
      false,
    );

    render(<Agent />);

    expect(screen.queryByTestId('agent-chip-skeleton')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-chip')).toBeInTheDocument();
  });

  it('resolves a builtin slug URL through the builtin id map', () => {
    route.pathname = '/agent/inbox';
    useAgentStore.setState(
      {
        activeAgentId: undefined,
        agentMap: { 'inbox-id': { id: 'inbox-id', title: 'Inbox Title' } },
        builtinAgentIdMap: { [INBOX_SESSION_ID]: 'inbox-id' },
      },
      false,
    );

    render(<Agent />);

    expect(screen.queryByTestId('agent-chip-skeleton')).not.toBeInTheDocument();
    expect(screen.getByText('Inbox Title')).toBeInTheDocument();
  });

  it('still shows a skeleton while the identity is genuinely unknown', () => {
    render(<Agent />);

    expect(screen.getByTestId('agent-chip-skeleton')).toBeInTheDocument();
  });
});

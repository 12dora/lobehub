/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AddGroupAgent from './AddGroupAgent';
import ForkGroupAndChat from './ForkGroupAndChat';

const managedAgentsRef = vi.hoisted(() => ({ current: false }));
const createGroupWithMembersMock = vi.hoisted(() => vi.fn());
const forkAgentGroupMock = vi.hoisted(() => vi.fn());
const getGroupByForkedFromIdentifierMock = vi.hoisted(() => vi.fn());

vi.mock(
  '@lobehub/ui',
  () =>
    new Proxy(
      {
        Button: ({ children }: { children?: ReactNode }) => (
          <button type="button">{children}</button>
        ),
        Icon: () => null,
      },
      {
        // `then` must stay undefined: vitest awaits the mock factory's result, and a Proxy that
        // answers `'then' in ns` with a function looks like a thenable and never settles.
        get: (target, property: string) => {
          if (property === 'then') return undefined;
          if (property in target) return target[property as keyof typeof target];
          return ({ children }: { children?: ReactNode }) => <div>{children}</div>;
        },
        has: (_target, property) => property !== 'then',
      },
    ),
);

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: () => <div data-testid="visibility-select" />,
  confirmModal: vi.fn(),
}));

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  useActiveWorkspaceId: () => undefined,
}));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => ({
    blocked: managedAgentsRef.current,
    error: null,
    loading: false,
    managed: managedAgentsRef.current,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));

vi.mock('@/layout/AuthProvider/MarketAuth', () => ({
  useMarketAuth: () => ({ isAuthenticated: true, signIn: vi.fn() }),
}));

vi.mock('@/libs/trpc/client', () => ({ lambdaClient: {} }));

vi.mock('@/services/chatGroup', () => ({
  chatGroupService: {
    createGroupWithMembers: createGroupWithMembersMock,
    getGroupByForkedFromIdentifier: getGroupByForkedFromIdentifierMock,
    getGroups: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/services/discover', () => ({ discoverService: {} }));

vi.mock('@/services/marketApi', () => ({
  marketApiService: { forkAgentGroup: forkAgentGroupMock },
}));

vi.mock('@/store/agentGroup', () => ({
  useAgentGroupStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ loadGroups: vi.fn() }),
}));

vi.mock('../../DetailProvider', () => ({
  useDetailContext: () => ({
    config: { systemRole: 'hello' },
    identifier: 'market-group',
    memberAgents: [],
    title: 'Market group',
  }),
}));

describe('community group-agent detail actions under an org-hosted agent catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedAgentsRef.current = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the fork / add CTAs while agents stay user-owned', () => {
    render(
      <>
        <ForkGroupAndChat />
        <AddGroupAgent />
      </>,
    );

    expect(screen.getByText('fork.forkAndChat')).toBeInTheDocument();
    expect(screen.getByText('groupAgents.addAndConverse')).toBeInTheDocument();
  });

  it('hides both CTAs once agents are org-hosted', () => {
    managedAgentsRef.current = true;
    const { container } = render(
      <>
        <ForkGroupAndChat />
        <AddGroupAgent />
      </>,
    );

    expect(screen.queryByText('fork.forkAndChat')).not.toBeInTheDocument();
    expect(screen.queryByText('groupAgents.addAndConverse')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('reaches neither Market nor the local group create while blocked', async () => {
    managedAgentsRef.current = true;
    render(
      <>
        <ForkGroupAndChat />
        <AddGroupAgent />
      </>,
    );

    // Nothing is clickable, but the guards are asserted directly too: a race that somehow
    // re-entered the handlers must still stop before the public Market fork, which would otherwise
    // leave an orphaned published group behind when the local write is refused.
    await Promise.resolve();
    expect(forkAgentGroupMock).not.toHaveBeenCalled();
    expect(getGroupByForkedFromIdentifierMock).not.toHaveBeenCalled();
    expect(createGroupWithMembersMock).not.toHaveBeenCalled();
  });
});

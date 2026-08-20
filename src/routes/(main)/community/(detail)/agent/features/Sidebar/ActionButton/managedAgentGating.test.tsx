/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AddAgent from './AddAgent';
import ForkAndChat from './ForkAndChat';

const managedAgentsRef = vi.hoisted(() => ({ current: false }));
const createAgentMock = vi.hoisted(() => vi.fn());

vi.mock('@lobechat/const', () => ({ AGENT_CHAT_URL: (id: string) => `/agent/${id}` }));

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
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
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

vi.mock('@/services/agent', () => ({ agentService: {} }));

vi.mock('@/services/discover', () => ({ discoverService: {} }));

vi.mock('@/services/marketApi', () => ({ marketApiService: {} }));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ createAgent: createAgentMock }),
}));

vi.mock('@/store/home', () => ({
  useHomeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ refreshAgentList: vi.fn() }),
}));

vi.mock('../../DetailProvider', () => ({
  useDetailContext: () => ({
    config: { systemRole: 'hello' },
    identifier: 'market-agent',
    title: 'Market agent',
  }),
}));

describe('community agent detail actions under an org-hosted agent catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedAgentsRef.current = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the add / fork CTAs while agents stay user-owned', () => {
    render(
      <>
        <AddAgent />
        <ForkAndChat />
      </>,
    );

    expect(screen.getByText('assistants.addAgentAndConverse')).toBeInTheDocument();
    expect(screen.getByText('fork.forkAndChat')).toBeInTheDocument();
  });

  it('hides both CTAs once agents are org-hosted (agent.createAgent is denied)', () => {
    managedAgentsRef.current = true;
    const { container } = render(
      <>
        <AddAgent />
        <ForkAndChat />
      </>,
    );

    expect(screen.queryByText('assistants.addAgentAndConverse')).not.toBeInTheDocument();
    expect(screen.queryByText('fork.forkAndChat')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
    expect(createAgentMock).not.toHaveBeenCalled();
  });
});

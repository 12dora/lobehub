/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UserAgentCard from './UserAgentCard';

const managedAgentsRef = vi.hoisted(() => ({ current: false }));

vi.mock(
  '@lobehub/ui',
  () =>
    new Proxy(
      {
        // Render the dropdown's item keys so we can assert on the menu contents without
        // opening a real popover.
        DropdownMenu: ({ items }: { items?: { key?: string }[] }) => (
          <div data-testid="menu">{(items ?? []).map((item) => item?.key ?? '').join(',')}</div>
        ),
        Icon: () => null,
        stopPropagation: () => {},
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

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: vi.fn(), success: vi.fn() } }) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  useActiveWorkspaceId: () => undefined,
}));

vi.mock('@/components/PublishedTime', () => ({ default: () => null }));

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

vi.mock('@/features/Workspace/WorkspaceLink', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));

vi.mock('@/services/agent', () => ({ agentService: {} }));

vi.mock('@/services/discover', () => ({ discoverService: {} }));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ createAgent: vi.fn() }),
}));

vi.mock('@/store/home', () => ({
  useHomeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ refreshAgentList: vi.fn() }),
}));

vi.mock('./DetailProvider', () => ({
  useUserDetailContext: () => ({ isOwner: true, onStatusChange: vi.fn() }),
}));

const cardProps = {
  createdAt: '2026-01-01',
  description: 'desc',
  identifier: 'market-agent',
  title: 'Market agent',
  tokenUsage: 0,
} as unknown as ComponentProps<typeof UserAgentCard>;

const renderCard = () => render(<UserAgentCard {...cardProps} />);

describe('UserAgentCard owner menu under an org-hosted agent catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedAgentsRef.current = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('offers the edit entry while agents stay user-owned', () => {
    renderCard();

    expect(screen.getByTestId('menu').textContent).toContain('edit');
  });

  it('drops the edit entry once agents are org-hosted (it installs via agent.createAgent)', () => {
    managedAgentsRef.current = true;
    renderCard();

    const keys = screen.getByTestId('menu').textContent?.split(',') ?? [];
    expect(keys).not.toContain('edit');
    // View detail and deprecate are unaffected — neither writes an agent definition.
    expect(keys).toContain('viewDetail');
    expect(keys).toContain('deprecate');
  });
});

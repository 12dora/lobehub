import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import GroupProfile from './index';

const mocks = vi.hoisted(() => ({ groupsLoading: true }));

// Only the loader is under test: it must stay hidden for the grace period and
// then appear inline (never the fullscreen brand splash, which is boxed inside
// the already-painted group shell).
vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: ({ debugId, variant }: { debugId: string; variant?: string }) => (
    <div data-debug-id={debugId} data-testid="loader" data-variant={variant} />
  ),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/features/WideScreenContainer', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./features/AgentBuilder', () => ({ default: () => null }));
vi.mock('./features/GroupProfile', () => ({ default: () => <div>group-settings</div> }));
vi.mock('./features/Header', () => ({ default: () => <div>header</div> }));
vi.mock('./features/MemberProfile', () => ({ default: () => null }));
vi.mock('./StoreSync', () => ({ default: () => null }));
vi.mock('@/store/agentGroup', () => ({
  useAgentGroupStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock('@/store/agentGroup/selectors', () => ({
  agentGroupSelectors: { isGroupsInit: () => mocks.groupsLoading },
}));
vi.mock('@/store/groupProfile', () => ({
  useGroupProfileStore: (selector: (state: unknown) => unknown) =>
    selector({ activeTabId: 'group', editor: undefined }),
}));

const DELAY_MS = 200;

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('GroupProfile hydration loader', () => {
  beforeEach(() => {
    mocks.groupsLoading = true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows no loader while the groups resolve inside the grace period', async () => {
    render(<GroupProfile />);

    expect(screen.queryByTestId('loader')).toBeNull();

    await advance(DELAY_MS - 1);
    expect(screen.queryByTestId('loader')).toBeNull();
  });

  it('shows the inline loader once the groups take longer than the grace period', async () => {
    render(<GroupProfile />);

    await advance(DELAY_MS);

    const loader = screen.getByTestId('loader');
    expect(loader.dataset.variant).toBe('inline');
    expect(loader.dataset.debugId).toBe('ProfileArea');
  });

  it('renders the profile, not a loader, once the groups are settled', async () => {
    mocks.groupsLoading = false;
    render(<GroupProfile />);

    await advance(DELAY_MS * 2);

    expect(screen.queryByTestId('loader')).toBeNull();
    expect(screen.getByText('group-settings')).toBeInTheDocument();
  });
});

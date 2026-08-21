import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AgentProfile from './index';

const mocks = vi.hoisted(() => ({ configError: undefined as unknown, configLoading: true }));

// Only the loader is under test: it must stay hidden for the grace period and
// then appear inline (never the fullscreen brand splash, which is boxed inside
// the already-painted agent shell).
vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: ({ debugId, variant }: { debugId: string; variant?: string }) => (
    <div data-debug-id={debugId} data-testid="loader" data-variant={variant} />
  ),
}));

// Real AsyncBoundary — its loading/error precedence is what routes to the loader.
vi.mock('@lobehub/ui', () => ({
  Center: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/NeuralNetworkLoading', () => ({ default: () => <div>default-loader</div> }));
vi.mock('@/components/AsyncError', () => ({ default: () => <div role="alert">error</div> }));

vi.mock('@/features/AgentBuilder', () => ({ default: () => null }));
vi.mock('@/features/ManagedResources', () => ({
  ManagedAgentConfigurationBoundary: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('@/features/WideScreenContainer', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('./features/EditLockDriver', () => ({ default: () => null }));
vi.mock('./features/Header', () => ({ default: () => <div>header</div> }));
vi.mock('./features/ProfileEditor', () => ({ default: () => <div>profile-editor</div> }));
vi.mock('./features/ProfileHydration', () => ({ default: () => null }));
vi.mock('./features/ProfileProvider', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('./features/store', () => ({
  selectors: { lockPending: () => false, lockedByOther: () => false },
  useProfileStore: (selector: (state: unknown) => unknown) => selector({ editor: undefined }),
}));
vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) =>
    selector({ retryAgentConfigFetch: vi.fn() }),
}));
vi.mock('@/store/agent/selectors', () => ({
  agentSelectors: {
    currentAgentConfigError: () => mocks.configError,
    isAgentConfigLoading: () => mocks.configLoading,
    isCurrentAgentHeterogeneous: () => false,
  },
}));

const DELAY_MS = 200;

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('AgentProfile hydration loader', () => {
  beforeEach(() => {
    mocks.configLoading = true;
    mocks.configError = undefined;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows no loader while the config resolves inside the grace period', async () => {
    render(<AgentProfile />);

    expect(screen.queryByTestId('loader')).toBeNull();

    await advance(DELAY_MS - 1);
    expect(screen.queryByTestId('loader')).toBeNull();
  });

  it('shows the inline loader once the config takes longer than the grace period', async () => {
    render(<AgentProfile />);

    await advance(DELAY_MS);

    const loader = screen.getByTestId('loader');
    expect(loader.dataset.variant).toBe('inline');
    expect(loader.dataset.debugId).toBe('ProfileArea');
  });

  it('renders the editor, not a loader, once the config is settled', async () => {
    mocks.configLoading = false;
    render(<AgentProfile />);

    await advance(DELAY_MS * 2);

    expect(screen.queryByTestId('loader')).toBeNull();
    expect(screen.getByText('profile-editor')).toBeInTheDocument();
  });

  it('keeps the error state instead of spinning when the config fetch failed', async () => {
    mocks.configError = new Error('offline');
    render(<AgentProfile />);

    await advance(DELAY_MS * 2);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('loader')).toBeNull();
  });
});

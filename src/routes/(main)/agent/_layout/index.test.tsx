/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import Layout from './index';

const mocks = vi.hoisted(() => ({ toggleLeftPanel: vi.fn() }));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
  ShikiLobeTheme: {},
}));

vi.mock('react-router', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = (await vi.importActual('react-router')) as typeof import('react-router');

  return {
    ...actual,
    Outlet: () => <div data-testid="agent-layout-outlet">outlet</div>,
  };
});

vi.mock('@/const/version', () => ({ isDesktop: false }));
vi.mock('@/hooks/useInitAgentConfig', () => ({ useInitAgentConfig: vi.fn() }));
vi.mock('@/features/ProtocolUrlHandler', () => ({ default: () => null }));
vi.mock('./RegisterHotkeys', () => ({ default: () => null }));
vi.mock('./Sidebar', () => ({ default: () => <div data-testid="agent-layout-sidebar" /> }));
vi.mock('@/routes/(main)/agent/_layout/AgentIdSync', () => ({
  default: () => <div data-testid="agent-layout-agent-id-sync" />,
}));

// Portal is "open" for the whole file so the collapse regression below is actually exercised.
vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (state: { showPortal: boolean }) => unknown) =>
    selector({ showPortal: true }),
}));
vi.mock('@/store/chat/selectors', () => ({
  chatPortalSelectors: { showPortal: (state: { showPortal: boolean }) => state.showPortal },
}));
vi.mock('@/store/global', () => {
  const state = { status: { showLeftPanel: true }, toggleLeftPanel: mocks.toggleLeftPanel };

  return {
    useGlobalStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

describe('Agent layout', () => {
  it('renders sidebar and outlet', () => {
    render(<Layout />);

    expect(screen.getByTestId('agent-layout-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('agent-layout-outlet')).toBeInTheDocument();
  });

  it('mounts AgentIdSync in layout', () => {
    render(<Layout />);

    expect(screen.getByTestId('agent-layout-agent-id-sync')).toBeInTheDocument();
  });

  it('never collapses the left nav panel when the chat portal is open', () => {
    mocks.toggleLeftPanel.mockClear();

    render(<Layout />);

    // Opening an assistant used to auto-collapse the sidebar; the panel is the user's to control.
    expect(mocks.toggleLeftPanel).not.toHaveBeenCalled();
  });
});

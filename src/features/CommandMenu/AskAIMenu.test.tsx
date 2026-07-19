import { render, screen } from '@testing-library/react';
import { Command } from 'cmdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AskAIMenu from './AskAIMenu';

const mocks = vi.hoisted(() => ({
  brandingName: 'AIHub AI',
  inboxTitle: '',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/enterprise/client/providers/RuntimeBrandingProvider', () => ({
  useBranding: () => ({ defaultAgentDisplayName: mocks.brandingName }),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

vi.mock('@/libs/swr/useCacheScope', () => ({
  useCacheScope: () => 'user-a:personal',
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      agentMap: { 'inbox-agent': { title: mocks.inboxTitle } },
      builtinAgentIdMap: { inbox: 'inbox-agent' },
      inboxProjectionScope: 'user-a:personal',
    }),
}));

vi.mock('@/store/agent/selectors', () => ({
  builtinAgentSelectors: {
    inboxAgentMetaForScope: (scope?: string) => (state: Record<string, unknown>) => {
      if (state.inboxProjectionScope !== scope) return undefined;
      const id = (state.builtinAgentIdMap as Record<string, string>).inbox;
      return (state.agentMap as Record<string, Record<string, unknown>>)[id];
    },
  },
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ isSignedIn: true }),
}));

vi.mock('@/store/user/selectors', () => ({
  authSelectors: { isLogin: (state: Record<string, unknown>) => state.isSignedIn },
}));

vi.mock('@/store/home', () => ({
  useHomeStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ allAgents: [] }),
    { getState: () => ({ sendAsAgent: vi.fn(), sendAsGroup: vi.fn() }) },
  ),
}));

vi.mock('@/store/home/selectors', () => ({
  homeAgentListSelectors: { allAgents: (state: { allAgents: unknown[] }) => state.allAgents },
}));

vi.mock('./CommandMenuContext', () => ({
  useCommandMenuContext: () => ({ search: '' }),
}));

vi.mock('./useCommandMenu', () => ({
  useCommandMenu: () => ({
    closeCommandMenu: vi.fn(),
    handleAIPainting: vi.fn(),
    handleAskLobeAI: vi.fn(),
  }),
}));

describe('AskAIMenu inbox display name', () => {
  beforeEach(() => {
    mocks.brandingName = 'AIHub AI';
    mocks.inboxTitle = '';
  });

  it.each([
    ['managed normalized title', 'Managed Assistant', 'Managed Assistant'],
    ['literal explicit title', 'Lobe AI', 'Lobe AI'],
    ['branding fallback', '', 'AIHub AI'],
  ])('renders the %s with the correct priority', (_scenario, inboxTitle, expected) => {
    mocks.inboxTitle = inboxTitle;

    render(
      <Command>
        <AskAIMenu />
      </Command>,
    );

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

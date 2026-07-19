import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MessengerBanner from './MessengerBanner';

const mocks = vi.hoisted(() => ({
  brandingName: 'AIHub AI',
  inboxTitle: '',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { name?: string }) =>
      `Talk to ${options?.name} on your favorite messaging apps`,
  }),
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

vi.mock('@/routes/(main)/agent/channel/const', () => ({
  getPlatformIcon: () => undefined,
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

vi.mock('@/store/global', () => ({
  useGlobalStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ status: {}, updateSystemStatus: vi.fn() }),
    { getState: () => ({ status: {} }) },
  ),
}));

describe('MessengerBanner inbox display name', () => {
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

    render(<MessengerBanner />);

    expect(
      screen.getByText(`Talk to ${expected} on your favorite messaging apps`),
    ).toBeInTheDocument();
  });
});

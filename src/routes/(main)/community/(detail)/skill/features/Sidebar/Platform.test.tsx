import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import discoverDefault from '../../../../../../../../packages/locales/src/default/discover';
import Platform from './Platform';

const interpolate = (template: string, options?: Record<string, unknown>) =>
  template.replaceAll(/\{\{(\w+)\}\}/g, (match, name: string) =>
    options && name in options ? String(options[name]) : match,
  );

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: keyof typeof discoverDefault, options?: Record<string, unknown>) =>
      interpolate(discoverDefault[key] ?? key, options),
  }),
}));

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lobehub/ui')>()),
  Highlighter: ({ children }: { children: ReactNode }) => <pre>{children}</pre>,
  Markdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/enterprise/client/providers/RuntimeBrandingProvider', () => ({
  useBranding: () => ({ name: 'Aurora' }),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

vi.mock('@/hooks/useDefaultInboxAvatar', () => ({
  useScopedDefaultInboxAvatar: () => 'https://brand.example.com/icon.png',
}));

vi.mock('@/hooks/useDefaultInboxDisplayName', () => ({
  useScopedDefaultInboxDisplayName: () => 'Aurora Assistant',
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: () => 'inbox-agent-1',
}));

vi.mock('@/store/agent/selectors', () => ({
  builtinAgentSelectors: { inboxAgentId: () => 'inbox-agent-1' },
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ sendMessage: vi.fn() }),
}));

describe('Skill sidebar Platform', () => {
  it('names the inbox action after the runtime display name', () => {
    render(<Platform identifier="my-skill" />);

    expect(screen.getByText('Use on Aurora Assistant')).toBeInTheDocument();
    expect(screen.queryByText('Use on LobeAI')).toBeNull();
  });
});

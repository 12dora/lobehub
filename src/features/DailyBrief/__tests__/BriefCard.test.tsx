import { INBOX_SESSION_ID } from '@lobechat/const';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BriefCard from '../BriefCard';
import type { AgentAvatarInfo, BriefItem } from '../types';

const mocks = vi.hoisted(() => ({
  branding: {
    defaultAgentDisplayName: null as string | null,
    iconUrl: null as string | null,
    logoUrl: null as string | null,
    publishedRevision: null as string | null,
  },
  inboxAgentId: undefined as string | undefined,
}));

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lobehub/ui')>()),
  Avatar: ({ avatar, title }: { avatar?: string; title?: string }) => (
    <div data-avatar={avatar} data-testid="producing-agent-avatar" data-title={title} />
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/enterprise/client/providers/RuntimeBrandingProvider', () => ({
  useBranding: () => mocks.branding,
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ builtinAgentIdMap: { [INBOX_SESSION_ID]: mocks.inboxAgentId } }),
}));

vi.mock('../BriefCardActions', () => ({ default: () => null }));
vi.mock('../BriefCardArtifacts', () => ({ default: () => null }));
vi.mock('../BriefCardSummary', () => ({ default: () => null }));

const buildBrief = (agent: AgentAvatarInfo): BriefItem =>
  ({
    actions: null,
    agent,
    agentId: agent.id,
    artifacts: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    id: 'brief-1',
    resolvedAction: null,
    summary: null,
    title: 'Daily digest',
  }) as unknown as BriefItem;

const readAvatar = () => screen.getByTestId('producing-agent-avatar');

describe('BriefCard producing agent avatar', () => {
  beforeEach(() => {
    mocks.branding = {
      defaultAgentDisplayName: 'AIHub AI',
      iconUrl: 'https://brand.example.com/icon.png',
      logoUrl: null,
      publishedRevision: '7',
    };
    mocks.inboxAgentId = 'inbox-agent-1';
  });

  it('brands the inbox agent identified by its database id', () => {
    render(
      <BriefCard
        brief={buildBrief({
          avatar: null,
          backgroundColor: null,
          id: 'inbox-agent-1',
          title: null,
        })}
      />,
    );

    expect(readAvatar()).toHaveAttribute('data-avatar', 'https://brand.example.com/icon.png');
    expect(readAvatar()).toHaveAttribute('data-title', 'AIHub AI');
  });

  it('does not brand an agent that merely matches the builtin inbox key', () => {
    render(
      <BriefCard
        brief={buildBrief({
          avatar: '🐳',
          backgroundColor: null,
          id: INBOX_SESSION_ID,
          title: 'Whale',
        })}
      />,
    );

    expect(readAvatar()).toHaveAttribute('data-avatar', '🐳');
    expect(readAvatar()).toHaveAttribute('data-title', 'Whale');
  });

  it('leaves other agents untouched', () => {
    render(
      <BriefCard
        brief={buildBrief({
          avatar: '🦊',
          backgroundColor: null,
          id: 'agent-42',
          title: 'Fox',
        })}
      />,
    );

    expect(readAvatar()).toHaveAttribute('data-avatar', '🦊');
    expect(readAvatar()).toHaveAttribute('data-title', 'Fox');
  });
});

/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import GroupMessage from './index';

const displayMessage = vi.hoisted(() => ({ current: {} as Record<string, any> }));

vi.mock('@/features/Conversation/ChatItem', () => ({
  // Only the slot under test — the group body is covered by its own tests.
  ChatItem: ({ aboveMessage }: { aboveMessage?: ReactNode }) => <div>{aboveMessage}</div>,
}));

vi.mock('../Assistant/Extra/ModerationNotice', () => ({
  default: ({ moderation }: { moderation?: { model?: string } }) =>
    moderation ? <div>{`notice:${moderation.model}`}</div> : null,
}));

vi.mock('../../store', () => ({
  contextSelectors: { groupId: () => undefined },
  dataSelectors: {
    getDisplayMessageById: () => () => displayMessage.current,
    getGroupLatestMessageWithoutTools: () => () => undefined,
  },
  messageStateSelectors: {
    isMessageEditing: () => () => false,
    isMessageInterrupted: () => () => false,
  },
  useConversationStore: (selector: (state: unknown) => unknown) =>
    selector({ addReaction: vi.fn(), removeReaction: vi.fn() }),
}));

vi.mock('../../hooks', () => ({ useAgentMeta: () => ({ title: 'Agent' }) }));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock('@/store/agent/selectors', () => ({
  builtinAgentSelectors: { isInboxAgent: () => false },
}));
vi.mock('@/store/agentGroup', () => ({
  useAgentGroupStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock('@/store/agentGroup/selectors', () => ({
  agentGroupSelectors: { getGroupMemberAvatars: () => () => [], getGroupMeta: () => () => ({}) },
}));
vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (state: unknown) => unknown) =>
    selector({ toggleSystemRole: vi.fn() }),
}));
vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock('@/store/user/selectors', () => ({
  labPreferSelectors: { enableFoldFinishedTurn: () => false },
  userGeneralSettingsSelectors: { config: () => ({ isDevMode: false }) },
  userProfileSelectors: { userId: () => 'user-1' },
}));
vi.mock('@/hooks/useInterceptingRoutes', () => ({ useOpenChatSettings: () => vi.fn() }));
vi.mock('@/libs/next/dynamic', () => ({ default: () => () => <div /> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@/features/AgentGroupAvatar', () => ({ default: () => <div /> }));
vi.mock('../../components/Reaction', () => ({ ReactionDisplay: () => <div /> }));
vi.mock('../Assistant/components/InterruptedHint', () => ({ default: () => <div /> }));
vi.mock('../components/Extras/Usage', () => ({ default: () => <div /> }));
vi.mock('../components/MessageBranch', () => ({ default: () => <div /> }));
vi.mock('../SignalCallbacks', () => ({ default: () => <div /> }));
vi.mock('../User/components/FileListViewer', () => ({ default: () => <div /> }));
vi.mock('./components/Group', () => ({ default: () => <div /> }));

const moderation = {
  action: 'downgrade' as const,
  model: 'safe-model',
  originalModel: 'gpt-4o',
  originalProvider: 'openai',
  provider: 'safe-provider',
};

const renderGroup = (message: Record<string, any>) => {
  displayMessage.current = { createdAt: Date.now(), id: 'group-1', ...message };
  return render(<GroupMessage id={'group-1'} index={0} />);
};

afterEach(cleanup);

describe('AssistantGroup 内容审计 downgrade notice', () => {
  const block = (id: string, model?: string) => ({
    content: id,
    id,
    ...(model && { metadata: { moderation: { ...moderation, model } } }),
  });

  it('renders the notice from the root metadata when the turn has no blocks', () => {
    renderGroup({ metadata: { moderation } });

    expect(screen.getByText('notice:safe-model')).toBeInTheDocument();
  });

  it('renders the notice when the visible final block was downgraded', () => {
    renderGroup({
      children: [block('block-1'), block('block-2', 'final-model')],
      metadata: {},
    });

    expect(screen.getByText('notice:final-model')).toBeInTheDocument();
  });

  it('renders NO notice when only an earlier step was downgraded and the final answer is clean', () => {
    renderGroup({
      children: [block('block-1', 'early-model'), block('block-2')],
      metadata: { moderation: { ...moderation, model: 'aggregated-model' } },
    });

    // The line sits above the whole turn: labelling a clean final answer with the model of an
    // earlier tool-calling step (or with metadata conversation-flow aggregated onto the root)
    // would misattribute what the reader is actually looking at.
    expect(screen.queryByText(/^notice:/)).not.toBeInTheDocument();
  });

  it('describes the final block, not an earlier downgraded one', () => {
    renderGroup({
      children: [block('block-1', 'early-model'), block('block-2', 'final-model')],
      metadata: {},
    });

    expect(screen.getByText('notice:final-model')).toBeInTheDocument();
    expect(screen.queryByText('notice:early-model')).not.toBeInTheDocument();
  });

  it('ignores aggregated root metadata once the turn has blocks', () => {
    renderGroup({
      children: [block('block-1')],
      metadata: { moderation },
    });

    expect(screen.queryByText(/^notice:/)).not.toBeInTheDocument();
  });

  it('renders nothing for an ordinary turn', () => {
    renderGroup({ children: [block('block-1')], metadata: {} });

    expect(screen.queryByText(/^notice:/)).not.toBeInTheDocument();
  });
});

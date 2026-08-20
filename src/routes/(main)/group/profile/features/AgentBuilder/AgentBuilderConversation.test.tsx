/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ThinkingEffort from '@/features/ChatInput/ActionBar/ThinkingEffort';
import { createStore, Provider } from '@/features/ChatInput/store';

import AgentBuilderConversation from './AgentBuilderConversation';

/** The builtin group Agent Builder row the conversation is bound to. */
const BUILDER_ID = 'group-agent-builder-id';
/** The group's own supervisor agent — `agentStore.activeAgentId` on this page. */
const EDITED_AGENT_ID = 'group-supervisor-id';

const updateAgentChatConfigById = vi.fn();

vi.mock('@lobehub/ui', () => ({
  Center: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/features/ChatInput/ActionBar/components/ActionDropdown', () => ({
  default: ({
    children,
    menu,
  }: {
    children?: ReactNode;
    menu: { items: { key: string; onClick: () => void }[] };
  }) => (
    <div>
      {children}
      {menu.items.map((item) => (
        <button key={item.key} type="button" onClick={item.onClick}>
          {`level-${item.key}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) =>
    selector({
      activeAgentId: EDITED_AGENT_ID,
      updateAgentChatConfigById,
      updateAgentConfigById: vi.fn(),
    }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgentModelById: () => () => 'gpt-5.6',
    getAgentModelProviderById: () => () => 'openai',
  },
  chatConfigByIdSelectors: {
    getChatConfigById: () => () => ({}),
  },
}));

vi.mock('@/store/aiInfra', () => ({
  aiModelSelectors: {
    modelExtendParams: () => () => ['gpt5_6ReasoningEffort'],
  },
  useAiInfraStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@/features/AgentBuilder/AgentBuilderWelcome', () => ({
  default: () => <div data-testid="agent-builder-welcome" />,
}));

vi.mock('@/features/AgentBuilder/SuggestionChips/useResolveFeedbackOnSend', () => ({
  useResolveFeedbackOnSend: vi.fn(),
}));

vi.mock('@/features/ChatInput', () => ({}));

vi.mock('@/features/Conversation', () => ({
  ChatInput: ({
    leftActions,
    rightActions,
    showControlBar,
  }: {
    leftActions: string[];
    rightActions: string[];
    showControlBar?: boolean;
  }) => (
    <div
      data-control-bar={String(showControlBar)}
      data-left-actions={leftActions.join(',')}
      data-right-actions={rightActions.join(',')}
      data-testid="chat-input"
    />
  ),
  ChatList: () => <div data-testid="chat-list" />,
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: true, reason: undefined }),
}));

vi.mock('./TopicSelector', () => ({
  default: () => <div data-testid="topic-selector" />,
}));

describe('group AgentBuilderConversation', () => {
  it('mounts the thinking-effort pill next to the model picker, matching the agent builder', () => {
    render(<AgentBuilderConversation agentId={BUILDER_ID} />);

    const input = screen.getByTestId('chat-input');

    expect(input).toHaveAttribute('data-left-actions', 'model,thinkingEffort');
  });

  it('keeps the builder composer minimal: no right actions, no control bar', () => {
    render(<AgentBuilderConversation agentId={BUILDER_ID} />);

    const input = screen.getByTestId('chat-input');

    expect(input).toHaveAttribute('data-right-actions', '');
    expect(input).toHaveAttribute('data-control-bar', 'false');
  });
});

/**
 * Same guarantee as the agent builder: the pill follows the ChatInput store's `agentId`
 * (the builtin group builder), never `agentStore.activeAgentId`.
 */
describe('group AgentBuilder thinking-effort pill target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the picked level onto the group builder row, not the supervisor agent', () => {
    render(
      <Provider createStore={() => createStore({ agentId: BUILDER_ID })}>
        <ThinkingEffort />
      </Provider>,
    );

    fireEvent.click(screen.getByText('level-high'));

    expect(updateAgentChatConfigById).toHaveBeenCalledWith(BUILDER_ID, {
      gpt5_6ReasoningEffort: 'high',
    });
    expect(updateAgentChatConfigById).not.toHaveBeenCalledWith(EDITED_AGENT_ID, expect.anything());
  });

  it('falls back to the active agent only when the conversation binds no agentId', () => {
    render(
      <Provider createStore={() => createStore({})}>
        <ThinkingEffort />
      </Provider>,
    );

    fireEvent.click(screen.getByText('level-high'));

    expect(updateAgentChatConfigById).toHaveBeenCalledWith(EDITED_AGENT_ID, {
      gpt5_6ReasoningEffort: 'high',
    });
  });
});

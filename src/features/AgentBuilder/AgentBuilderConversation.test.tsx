/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ThinkingEffort from '@/features/ChatInput/ActionBar/ThinkingEffort';
import { createStore, Provider } from '@/features/ChatInput/store';

import AgentBuilderConversation from './AgentBuilderConversation';

/** The builtin Agent Builder row the conversation is bound to. */
const BUILDER_ID = 'agent-builder-id';
/** The assistant being edited on the profile page — `agentStore.activeAgentId`. */
const EDITED_AGENT_ID = 'edited-agent-id';

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

vi.mock('@/components/DragUploadZone', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useUploadFiles: () => ({ handleUploadFiles: vi.fn() }),
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

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) =>
    selector({
      // The profile page keeps `activeAgentId` on the assistant being edited — the pill
      // must NOT write there.
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

vi.mock('./AgentBuilderWelcome', () => ({
  default: () => <div data-testid="agent-builder-welcome" />,
}));

vi.mock('./SuggestionChips/useResolveFeedbackOnSend', () => ({
  useResolveFeedbackOnSend: vi.fn(),
}));

vi.mock('./TopicSelector', () => ({
  default: () => <div data-testid="topic-selector" />,
}));

describe('AgentBuilderConversation', () => {
  it('mounts the thinking-effort pill next to the model picker, like the main chat composer', () => {
    render(<AgentBuilderConversation agentId="agent-builder-id" />);

    const input = screen.getByTestId('chat-input');

    expect(input).toHaveAttribute('data-left-actions', 'model,thinkingEffort');
  });

  it('keeps the builder composer minimal: no right actions, no control bar', () => {
    render(<AgentBuilderConversation agentId="agent-builder-id" />);

    const input = screen.getByTestId('chat-input');

    expect(input).toHaveAttribute('data-right-actions', '');
    expect(input).toHaveAttribute('data-control-bar', 'false');
  });
});

/**
 * The pill is bound to the ChatInput store's `agentId` (the builtin builder), not to
 * `agentStore.activeAgentId` (the assistant being edited on the same page). Mounting the
 * real `ThinkingEffort` inside the real ChatInput store provider — with the real
 * `useAgentId` / `useUpdateAgentConfig` — is what proves the write lands on the builder.
 */
describe('AgentBuilder thinking-effort pill target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the picked level onto the builder row, not the edited assistant', () => {
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

  it('falls back to the edited assistant only when the conversation binds no agentId', () => {
    // Negative control: proves the assertion above is driven by the binding, not by a
    // harness that could never reach `activeAgentId`.
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

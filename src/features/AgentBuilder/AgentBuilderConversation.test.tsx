/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import AgentBuilderConversation from './AgentBuilderConversation';

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
  usePermission: () => ({ allowed: true }),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgentModelById: () => () => 'gpt-5.6',
    getAgentModelProviderById: () => () => 'openai',
  },
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

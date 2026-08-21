/**
 * The welcome / skeleton / list decision in `ChatList` is what the home
 * composer's "open the conversation in place" flow lands on: the surface mounts
 * while `sendMessage` is still in flight, on a topic-less context. Getting the
 * branch order wrong flashes `AgentHome` (an empty agent card) over the message
 * the user just sent.
 *
 * The operation predicate is exercised for real — only the store *containers*
 * are faked, `operationSelectors` is the production implementation.
 *
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ChatList from './index';

interface FakeConversationState {
  context: {
    agentId?: string;
    threadId?: string | null;
    topicId?: string | null;
    topicShareId?: string;
  };
  displayMessageIds: string[];
  displayMessages: { id: string; role: string }[];
  messagesInit: boolean;
  skipFetch: boolean;
  /** Mirrors the store field name — ChatList calls this one as a hook. */
  useFetchMessages: () => {
    error?: unknown;
    isLoading: boolean;
    isValidating: boolean;
    mutate: () => void;
  };
}

const conversationState = vi.hoisted(
  () =>
    ({
      context: { agentId: 'agt_1', threadId: null, topicId: null },
      displayMessageIds: [],
      displayMessages: [],
      messagesInit: true,
      skipFetch: false,
      // eslint-disable-next-line @eslint-react/no-unnecessary-use-prefix
      useFetchMessages: () => ({
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: () => {},
      }),
    }) as FakeConversationState,
);

const chatState = vi.hoisted(() => ({
  activeAgentId: 'agt_1' as string | undefined,
  operations: {} as Record<string, any>,
  operationsByContext: {} as Record<string, string[]>,
}));

vi.mock('../store', () => ({
  dataSelectors: {
    displayMessageIds: (s: FakeConversationState) => s.displayMessageIds,
    displayMessages: (s: FakeConversationState) => s.displayMessages,
    messagesInit: (s: FakeConversationState) => s.messagesInit,
    skipFetch: (s: FakeConversationState) => s.skipFetch,
  },
  useConversationStore: (selector: (s: FakeConversationState) => unknown) =>
    selector(conversationState),
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (s: typeof chatState) => unknown) => selector(chatState),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (s: { useFetchAgentConfig: () => void }) => unknown) =>
    selector({ useFetchAgentConfig: () => {} }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: unknown) => unknown) => selector({}),
}));
vi.mock('@/store/user/selectors', () => ({
  authSelectors: { isLogin: () => true },
  settingsSelectors: { memoryEnabled: () => false },
}));

vi.mock('@/store/serverConfig', () => ({
  featureFlagsSelectors: () => ({ enableAgentSelfIteration: false }),
  useServerConfigStore: (selector: (s: unknown) => unknown) => selector({}),
}));

vi.mock('@/hooks/useFetchMemoryForTopic', () => ({ useFetchTopicMemories: () => {} }));
vi.mock('@/hooks/useFetchNotebookDocuments', () => ({ useFetchNotebookDocuments: () => {} }));

vi.mock('@/components/AsyncError', () => ({
  default: () => <div data-testid="async-error" />,
}));
vi.mock('../../WideScreenContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="welcome-wrapper">{children}</div>
  ),
}));
vi.mock('../components/SkeletonList', () => ({
  default: () => <div data-testid="skeleton-list" />,
}));
vi.mock('../Messages', () => ({ default: () => null }));
vi.mock('../Messages/Contexts/MessageActionProvider', () => ({
  MessageActionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/AgentSignalReceiptList', () => ({ default: () => null }));
vi.mock('./components/RefreshingHint', () => ({ default: () => null }));
vi.mock('./components/VirtualizedList', () => ({
  default: ({ dataSource }: { dataSource: string[] }) => (
    <div data-testid="virtualized-list">{dataSource.join(',')}</div>
  ),
}));
vi.mock('./hooks/useAgentSignalReceipts', () => ({
  useAgentSignalReceipts: () => ({ receiptsByAnchor: new Map() }),
}));

const AgentHome = <div data-testid="agent-home" />;

const startSend = (contextKey = 'main_agt_1_new') => {
  chatState.operations = {
    op_send: {
      context: { agentId: 'agt_1', threadId: undefined },
      id: 'op_send',
      metadata: { startTime: Date.now() },
      status: 'running',
      type: 'sendMessage',
    },
  };
  chatState.operationsByContext = { [contextKey]: ['op_send'] };
};

const seedMessages = (count: number) => {
  conversationState.displayMessages = Array.from({ length: count }, (_, i) => ({
    id: `tmp_${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
  }));
  conversationState.displayMessageIds = conversationState.displayMessages.map((m) => m.id);
};

describe('ChatList welcome / pending branch', () => {
  beforeEach(() => {
    conversationState.context = { agentId: 'agt_1', threadId: null, topicId: null };
    conversationState.displayMessageIds = [];
    conversationState.displayMessages = [];
    conversationState.messagesInit = true;
    conversationState.skipFetch = false;
    chatState.operations = {};
    chatState.operationsByContext = {};
  });

  it('shows the welcome on a genuinely empty new chat', () => {
    render(<ChatList welcome={AgentHome} />);

    expect(screen.getByTestId('agent-home')).toBeTruthy();
    expect(screen.queryByTestId('virtualized-list')).toBeNull();
  });

  it('shows the optimistic list instead of the welcome once tmp messages exist', () => {
    seedMessages(2);

    render(<ChatList welcome={AgentHome} />);

    expect(screen.queryByTestId('agent-home')).toBeNull();
    expect(screen.getByTestId('virtualized-list').textContent).toBe('tmp_0,tmp_1');
  });

  it('shows a neutral pending state — never the welcome — while a send is in flight', () => {
    startSend();

    render(<ChatList welcome={AgentHome} />);

    expect(screen.queryByTestId('agent-home')).toBeNull();
    expect(screen.getByTestId('skeleton-list')).toBeTruthy();
  });

  it('renders the list when the in-flight send has already seeded its bubbles', () => {
    startSend();
    seedMessages(2);

    render(<ChatList welcome={AgentHome} />);

    expect(screen.queryByTestId('agent-home')).toBeNull();
    expect(screen.queryByTestId('skeleton-list')).toBeNull();
    expect(screen.getByTestId('virtualized-list').textContent).toBe('tmp_0,tmp_1');
  });

  it('ignores a send running in a different context', () => {
    // The operation belongs to another agent's bucket — this surface is still
    // an empty new chat and must keep its welcome.
    startSend('main_agt_other_new');

    render(<ChatList welcome={AgentHome} />);

    expect(screen.getByTestId('agent-home')).toBeTruthy();
  });

  it('keeps an explicit showWelcome override even during an in-flight send', () => {
    // Onboarding pins its greeting state through `showWelcome`; that is a
    // caller decision, not the accidental empty-state this branch guards.
    startSend();

    render(<ChatList showWelcome welcome={AgentHome} />);

    expect(screen.getByTestId('agent-home')).toBeTruthy();
  });

  it('skeletons an existing topic whose messages have not initialised', () => {
    conversationState.context = { agentId: 'agt_1', threadId: null, topicId: 'tpc_1' };
    conversationState.messagesInit = false;

    render(<ChatList welcome={AgentHome} />);

    expect(screen.getByTestId('skeleton-list')).toBeTruthy();
  });

  it('renders the list for a seeded existing topic', () => {
    conversationState.context = { agentId: 'agt_1', threadId: null, topicId: 'tpc_1' };
    seedMessages(2);

    render(<ChatList welcome={AgentHome} />);

    expect(screen.queryByTestId('skeleton-list')).toBeNull();
    expect(screen.getByTestId('virtualized-list').textContent).toBe('tmp_0,tmp_1');
  });
});

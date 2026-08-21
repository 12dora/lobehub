/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InputArea from './index';

const prefetchAgentSurfaceMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/HomeConversation', () => ({
  prefetchAgentSurface: prefetchAgentSurfaceMock,
}));

vi.mock('./useSend', () => ({
  useSend: () => ({ agentId: 'agt_inbox', loading: false, send: vi.fn() }),
}));

vi.mock('./InputDragUpload', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/DragUploadZone', () => ({
  useUploadFiles: () => ({ handleUploadFiles: vi.fn() }),
}));

vi.mock('@/features/ChatInput', () => ({
  ChatInputProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DesktopChatInput: () => <textarea data-testid="composer" />,
}));

vi.mock('@/hooks/useInitAgentConfig', () => ({ useInitAgentConfig: () => ({ isLoading: false }) }));
vi.mock('@/hooks/useHomeDailyBrief', () => ({
  useHomeDailyBrief: () => ({ advance: vi.fn(), currentPair: undefined }),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (s: unknown) => unknown) => selector({}),
}));
vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgentModelById: () => () => 'gpt-4o',
    getAgentModelProviderById: () => () => 'openai',
    isAgentConfigLoadingById: () => () => false,
  },
}));
vi.mock('@/store/chat', () => ({
  useChatStore: Object.assign((selector: (s: unknown) => unknown) => selector({}), {
    setState: vi.fn(),
  }),
}));

describe('Home InputArea', () => {
  beforeEach(() => {
    prefetchAgentSurfaceMock.mockReset();
  });

  it('warms the lazy conversation chunk as soon as the composer takes focus', () => {
    render(<InputArea />);

    expect(prefetchAgentSurfaceMock).not.toHaveBeenCalled();

    // Focus bubbles up through the capture handler on the composer wrapper —
    // the chunk has to be resolved before Enter swaps the right column, or
    // `DelayedFallback` leaves it blank for its first 200ms.
    fireEvent.focus(screen.getByTestId('composer'));

    expect(prefetchAgentSurfaceMock).toHaveBeenCalled();
  });
});

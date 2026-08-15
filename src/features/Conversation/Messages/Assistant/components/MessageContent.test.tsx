/**
 * @vitest-environment happy-dom
 */
import { type ChatFileItem, type UIChatMessage } from '@lobechat/types';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MessageContent from './MessageContent';

vi.mock('../../../store', () => ({
  messageStateSelectors: {
    isMessageGenerating: () => () => false,
    isMessageCreating: () => () => false,
    isMessageCollapsed: () => () => false,
    isMessageInReasoning: () => () => false,
  },
  useConversationStore: (selector: (state: unknown) => unknown) =>
    selector({ addReaction: vi.fn(), removeReaction: vi.fn() }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/user/selectors', () => ({
  userProfileSelectors: { userId: () => 'user-1' },
}));

vi.mock('../useMarkdown', () => ({
  useMarkdown: () => ({ drawer: null, markdownProps: {} }),
}));

vi.mock('../../components/DisplayContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="content">{content}</div>,
}));

vi.mock('../../components/FileChunks', () => ({ default: () => <div /> }));
vi.mock('../../components/Reasoning', () => ({ default: () => <div /> }));
vi.mock('../../components/SearchGrounding', () => ({ default: () => <div /> }));
vi.mock('../../AssistantGroup/components/CollapsedMessage', () => ({
  CollapsedMessage: () => <div />,
}));
vi.mock('../../../components/Reaction', () => ({ ReactionDisplay: () => <div /> }));

vi.mock('../../components/ImageFileListViewer', () => ({
  default: ({ items }: { items: unknown[] }) => (
    <div data-testid="image-viewer">{items.length}</div>
  ),
}));

vi.mock('../../User/components/FileListViewer', () => ({
  default: ({ items }: { items: ChatFileItem[] }) => (
    <div data-testid="file-viewer">{items.map((item) => item.name).join(',')}</div>
  ),
}));

const baseMessage = {
  content: 'here is your report',
  createdAt: 1,
  id: 'msg-1',
  meta: {},
  role: 'assistant',
  updatedAt: 1,
} as unknown as UIChatMessage;

describe('Assistant MessageContent', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the file list viewer when the assistant message carries files', () => {
    render(
      <MessageContent
        {...baseMessage}
        fileList={[
          {
            fileType: 'application/pdf',
            id: 'file-1',
            name: 'aihub-test.pdf',
            size: 2048,
            url: 'https://s3/aihub-test.pdf',
          },
        ]}
      />,
    );

    expect(screen.getByTestId('file-viewer')).toHaveTextContent('aihub-test.pdf');
  });

  it('does not render the file list viewer without files', () => {
    render(<MessageContent {...baseMessage} />);

    expect(screen.queryByTestId('file-viewer')).not.toBeInTheDocument();
  });

  it('does not render the file list viewer for an empty file list', () => {
    render(<MessageContent {...baseMessage} fileList={[]} />);

    expect(screen.queryByTestId('file-viewer')).not.toBeInTheDocument();
  });
});

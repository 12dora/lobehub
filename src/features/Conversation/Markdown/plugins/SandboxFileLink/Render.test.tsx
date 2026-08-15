import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatStore } from '@/store/chat';
import { PortalViewType } from '@/store/chat/slices/portal/initialState';

import * as storeModule from '../../../store';
import type { MarkdownElementProps } from '../type';
import Render from './Render';

vi.mock('../../../store', async (importOriginal) => {
  const original = await importOriginal<typeof storeModule>();
  return { ...original, useConversationStore: vi.fn() };
});

vi.mock('@/components/FileIcon', () => ({
  default: ({ fileName, size }: { fileName: string; size?: number }) => (
    <span data-file-name={fileName} data-size={size} data-testid="file-icon" />
  ),
}));

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  Tooltip: ({ children, title }: { children: ReactNode; title?: ReactNode }) => (
    <span
      data-testid="sandbox-file-tooltip"
      data-title={typeof title === 'string' ? title : undefined}
    >
      {children}
    </span>
  ),
}));

const mockUseConversationStore = vi.mocked(storeModule.useConversationStore);

const MESSAGE_ID = 'msg-1';

const FILE = {
  fileType: 'application/pdf',
  id: 'file-1',
  name: 'aihub-uat7.pdf',
  size: 20_480,
  url: 'https://example.com/aihub-uat7.pdf',
};

const createProps = (
  properties: Record<string, string>,
): MarkdownElementProps<Record<string, string>> => ({
  children: null,
  id: MESSAGE_ID,
  node: { properties },
  tagName: 'lobeSandboxFileLink',
  type: 'element',
});

/** The Render only reads the message `fileList` out of the conversation store. */
const mockFileList = (fileList: unknown) => {
  mockUseConversationStore.mockImplementation((selector: any) =>
    selector({ dbMessages: [{ fileList, id: MESSAGE_ID }] }),
  );
};

describe('SandboxFileLink Render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    useChatStore.setState(useChatStore.getInitialState());
  });

  describe('matched: the message carries the generated file', () => {
    beforeEach(() => {
      mockFileList([FILE]);
    });

    it('opens the file preview portal on click', () => {
      render(
        <Render
          {...createProps({
            fileName: 'aihub-uat7.pdf',
            filePath: '/mnt/data/aihub-uat7.pdf',
            linkLabel: '下载 aihub-uat7.pdf',
          })}
        />,
      );

      const chip = screen.getByRole('button', { name: '下载 aihub-uat7.pdf' });
      expect(screen.getByTestId('file-icon')).toHaveAttribute('data-file-name', 'aihub-uat7.pdf');
      expect(screen.getByTestId('sandbox-file-tooltip')).toHaveAttribute(
        'data-title',
        'aihub-uat7.pdf · 20.0 KB',
      );

      fireEvent.click(chip);

      expect(useChatStore.getState().portalStack).toEqual([
        { file: { fileId: 'file-1' }, type: PortalViewType.FilePreview },
      ]);
      expect(useChatStore.getState().showPortal).toBe(true);
    });

    it('is keyboard operable', () => {
      render(
        <Render
          {...createProps({
            fileName: 'aihub-uat7.pdf',
            filePath: '/mnt/data/aihub-uat7.pdf',
            linkLabel: 'aihub-uat7.pdf',
          })}
        />,
      );

      fireEvent.keyDown(screen.getByRole('button', { name: 'aihub-uat7.pdf' }), { key: 'Enter' });

      expect(useChatStore.getState().portalStack).toEqual([
        { file: { fileId: 'file-1' }, type: PortalViewType.FilePreview },
      ]);
    });

    it('matches case-insensitively when the sandbox path case differs', () => {
      render(
        <Render
          {...createProps({
            fileName: 'AIHub-UAT7.PDF',
            filePath: '/mnt/data/AIHub-UAT7.PDF',
            linkLabel: 'download',
          })}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'download' }));

      expect(useChatStore.getState().portalStack).toEqual([
        { file: { fileId: 'file-1' }, type: PortalViewType.FilePreview },
      ]);
    });
  });

  describe('unmatched: no attachment to bind to', () => {
    it('renders plain text when the message has no fileList', () => {
      mockFileList(undefined);

      render(
        <Render
          {...createProps({
            fileName: 'aihub-uat7.pdf',
            filePath: '/mnt/data/aihub-uat7.pdf',
            linkLabel: '下载 aihub-uat7.pdf',
          })}
        />,
      );

      expect(screen.getByText('下载 aihub-uat7.pdf')).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    });

    it('renders plain text when no attachment matches the sandbox path', () => {
      mockFileList([FILE]);

      render(
        <Render
          {...createProps({
            fileName: 'other.pdf',
            filePath: '/mnt/data/other.pdf',
            linkLabel: 'other.pdf',
          })}
        />,
      );

      expect(screen.getByText('other.pdf')).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull();
      expect(useChatStore.getState().portalStack).toEqual([]);
    });
  });
});

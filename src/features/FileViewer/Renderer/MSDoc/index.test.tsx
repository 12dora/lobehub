import { render, screen, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type DocumentPreviewResult } from '@/types/files/render';

import MSDocViewer from './index';
import {
  DOCUMENT_PREVIEW_READY_REFRESH_INTERVAL,
  getPreviewRefreshInterval,
} from './useDocumentPreview';

const getDocumentPreview = vi.hoisted(() => vi.fn());

vi.mock('@/services/file', () => ({
  fileService: { getDocumentPreview },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => ({ page: 'page' }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

vi.mock('@lobehub/ui', () => ({
  Center: ({ children }: PropsWithChildren) => <div>{children}</div>,
  Flexbox: ({ children }: PropsWithChildren) => <div>{children}</div>,
  FluentEmoji: () => <span />,
  Text: ({ children }: PropsWithChildren) => <span>{children}</span>,
}));

vi.mock('@/components/NeuralNetworkLoading', () => ({
  default: () => <div data-testid={'loading'} />,
}));

vi.mock('@/utils/client/downloadFile', () => ({
  downloadFile: vi.fn(),
}));

vi.mock('../PDF', () => ({
  default: ({ fileId, url }: { fileId: string; url: string | null }) => (
    <div data-file-id={fileId} data-testid={'pdf-viewer'} data-url={url} />
  ),
}));

vi.mock('../../NotSupport', () => ({
  default: () => <div data-testid={'not-support'} />,
}));

const renderViewer = () =>
  render(
    createElement(
      SWRConfig,
      { value: { provider: () => new Map() } },
      <MSDocViewer fileId={'file_1'} fileName={'deck.pptx'} url={'https://s3/deck.pptx'} />,
    ),
  );

const result = (data: DocumentPreviewResult) => data;

describe('MSDocViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the PDF rendition when the preview is ready', async () => {
    getDocumentPreview.mockResolvedValue(
      result({ pageCount: 3, status: 'ready', url: 'https://s3/rendition.pdf' }),
    );

    renderViewer();

    const viewer = await screen.findByTestId('pdf-viewer');
    expect(viewer).toHaveAttribute('data-url', 'https://s3/rendition.pdf');
    // keyed apart from the office file so its chunk highlights are not reused
    expect(viewer).toHaveAttribute('data-file-id', 'file_1:preview');
  });

  it('shows the preparing state while the conversion is pending', async () => {
    getDocumentPreview.mockResolvedValue(result({ status: 'pending' }));

    renderViewer();

    expect(await screen.findByText('preview.document.preparing')).toBeInTheDocument();
    expect(screen.getByText('preview.document.preparingDesc')).toBeInTheDocument();
    expect(screen.queryByTestId('pdf-viewer')).toBeNull();
  });

  it('explains an unavailable rendering service and still offers the download', async () => {
    getDocumentPreview.mockResolvedValue(result({ status: 'unavailable' }));

    renderViewer();

    expect(await screen.findByText('preview.document.unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'preview.downloadFile' })).toBeInTheDocument();
  });

  it('shows the failure reason when the render failed', async () => {
    getDocumentPreview.mockResolvedValue(result({ error: 'conversion timeout', status: 'failed' }));

    renderViewer();

    expect(await screen.findByText('preview.document.failed')).toBeInTheDocument();
    expect(screen.getByText('conversion timeout')).toBeInTheDocument();
  });

  it('falls back to the not-supported state for unsupported files', async () => {
    getDocumentPreview.mockResolvedValue(result({ status: 'unsupported' }));

    renderViewer();

    expect(await screen.findByTestId('not-support')).toBeInTheDocument();
  });

  it('swaps the preparing state for the PDF once the conversion finishes', async () => {
    getDocumentPreview
      .mockResolvedValueOnce(result({ status: 'pending' }))
      .mockResolvedValue(result({ status: 'ready', url: 'https://s3/rendition.pdf' }));

    renderViewer();

    expect(await screen.findByText('preview.document.preparing')).toBeInTheDocument();

    await waitFor(
      async () => {
        expect(await screen.findByTestId('pdf-viewer')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(getDocumentPreview.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('getPreviewRefreshInterval', () => {
  it('polls every 2s while pending', () => {
    expect(getPreviewRefreshInterval({ status: 'pending' }, false)).toBe(2000);
  });

  it('stops polling once the preview resolves', () => {
    expect(getPreviewRefreshInterval({ status: 'ready', url: 'https://s3/a.pdf' }, false)).toBe(
      DOCUMENT_PREVIEW_READY_REFRESH_INTERVAL,
    );
    expect(getPreviewRefreshInterval({ status: 'failed' }, false)).toBe(0);
    expect(getPreviewRefreshInterval(undefined, false)).toBe(0);
  });

  it('stops polling after we gave up waiting', () => {
    expect(getPreviewRefreshInterval({ status: 'pending' }, true)).toBe(0);
  });
});

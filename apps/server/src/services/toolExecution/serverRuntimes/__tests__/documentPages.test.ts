// @vitest-environment node
import { DocumentPagesIdentifier } from '@lobechat/builtin-tool-document-pages/manifest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolExecutionContext } from '../../types';

const findById = vi.fn();
const enqueueDocumentRenderJob = vi.fn();

vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn().mockImplementation(() => ({
    findById: (...args: unknown[]) => findById(...args),
  })),
}));

vi.mock('../../../../enterprise/services/documentRender', () => ({
  enqueueDocumentRenderJob: (...args: unknown[]) => enqueueDocumentRenderJob(...args),
}));

const { documentPagesRuntime } = await import('../documentPages');

const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  serverDB: {} as never,
  toolManifestMap: {},
  userId: 'user-1',
  ...overrides,
});

describe('documentPagesRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the document-pages identifier', () => {
    expect(documentPagesRuntime.identifier).toBe(DocumentPagesIdentifier);
  });

  it('throws without serverDB or userId', () => {
    expect(() => documentPagesRuntime.factory({ toolManifestMap: {}, userId: 'u' })).toThrow(
      'serverDB is required',
    );
    expect(() =>
      documentPagesRuntime.factory({ serverDB: {} as never, toolManifestMap: {} }),
    ).toThrow('userId is required');
  });

  it('returns markers for a ready render', async () => {
    findById.mockResolvedValue({
      fileType: 'application/pdf',
      id: 'file-1',
      metadata: {
        render: {
          pages: { '2': { chars: 10, png: 'files/render/file-1/pages/2.png', visual: true } },
          renderedPages: [2],
          status: 'ready',
        },
      },
      name: 'deck.pdf',
    });

    const runtime = documentPagesRuntime.factory(context());
    const result = await runtime.viewDocumentPages({ fileId: 'file-1', pages: [2] });

    expect(result.success).toBe(true);
    expect(result.content).toContain('Requested page images for "deck.pdf": pages 2.');
    expect(result.content).toContain(
      '<document_page_image fileId="file-1" page="2" kind="page" key="files/render/file-1/pages/2.png"/>',
    );
  });

  it('returns a pending notice without enqueueing', async () => {
    findById.mockResolvedValue({
      fileType: 'application/pdf',
      id: 'file-1',
      metadata: { render: { status: 'pending' } },
      name: 'deck.pdf',
    });

    const runtime = documentPagesRuntime.factory(context());
    const result = await runtime.viewDocumentPages({ fileId: 'file-1', pages: [1] });

    expect(result.success).toBe(true);
    expect(result.content).toBe('Page images are still being prepared, try again later.');
    expect(enqueueDocumentRenderJob).not.toHaveBeenCalled();
  });

  it('enqueues on-demand render when metadata is missing for an office file', async () => {
    findById.mockResolvedValue({
      fileType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      id: 'file-1',
      metadata: {},
      name: 'deck.pptx',
    });
    enqueueDocumentRenderJob.mockResolvedValue({ created: true, jobId: 'job-1' });

    const runtime = documentPagesRuntime.factory(context({ workspaceId: 'ws-1' }));
    const result = await runtime.viewDocumentPages({ fileId: 'file-1', pages: [1, 2] });

    expect(result.content).toBe('Page images are processing, please retry later.');
    expect(enqueueDocumentRenderJob).toHaveBeenCalledWith(
      expect.anything(),
      { fileId: 'file-1', force: true },
    );
  });

  it('returns not found when the scoped lookup misses', async () => {
    findById.mockResolvedValue(undefined);

    const runtime = documentPagesRuntime.factory(context());
    const result = await runtime.viewDocumentPages({ fileId: 'missing', pages: [1] });

    expect(result.success).toBe(false);
    expect(result.content).toBe('File not found or not accessible: missing');
  });

  it('emits tile markers when zoom is tiles and a single page has tiles', async () => {
    findById.mockResolvedValue({
      fileType: 'application/pdf',
      id: 'file-1',
      metadata: {
        render: {
          pages: {
            '1': {
              chars: 4,
              png: 'files/render/file-1/pages/1.png',
              tiles: ['files/render/file-1/tiles/1-00.png', 'files/render/file-1/tiles/1-01.png'],
              visual: true,
            },
          },
          status: 'ready',
        },
      },
      name: 'scan.pdf',
    });

    const runtime = documentPagesRuntime.factory(context());
    const result = await runtime.viewDocumentPages({
      fileId: 'file-1',
      pages: [1],
      zoom: 'tiles',
    });

    expect(result.content).toContain('kind="tile" key="files/render/file-1/tiles/1-00.png"');
    expect(result.content).toContain('kind="tile" key="files/render/file-1/tiles/1-01.png"');
    expect(result.content).not.toContain('kind="page"');
  });
});

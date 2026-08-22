// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentPagesExecutionRuntime } from './index';

describe('DocumentPagesExecutionRuntime partial recoverability', () => {
  const enqueueRender = vi.fn();
  const findAccessibleFile = vi.fn();
  const runtime = new DocumentPagesExecutionRuntime({ enqueueRender, findAccessibleFile });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('force-enqueues once when partial render has no png for requested pages', async () => {
    findAccessibleFile.mockResolvedValue({
      fileType: 'application/pdf',
      id: 'file-1',
      metadata: {
        render: { error: 'sidecar unavailable', figures: [], status: 'partial', tier: 'T2' },
      },
      name: 'deck.pdf',
    });
    enqueueRender.mockResolvedValue({ created: false, jobId: 'job-1' });

    const result = await runtime.viewDocumentPages({ fileId: 'file-1', pages: [1, 2] });

    expect(enqueueRender).toHaveBeenCalledTimes(1);
    expect(enqueueRender).toHaveBeenCalledWith('file-1', { force: true });
    expect(result.success).toBe(true);
    expect(result.content).toContain('are being prepared');
    expect(result.state).toMatchObject({ pages: [1, 2], status: 'processing' });
  });

  it('does not enqueue when partial render already has the requested png', async () => {
    findAccessibleFile.mockResolvedValue({
      fileType: 'application/pdf',
      id: 'file-1',
      metadata: {
        render: {
          pages: { '1': { chars: 10, png: 'files/render/file-1/pages/1.png', visual: true } },
          status: 'partial',
        },
      },
      name: 'deck.pdf',
    });

    const result = await runtime.viewDocumentPages({ fileId: 'file-1', pages: [1] });

    expect(enqueueRender).not.toHaveBeenCalled();
    expect(result.content).toContain('Requested page images');
  });
});

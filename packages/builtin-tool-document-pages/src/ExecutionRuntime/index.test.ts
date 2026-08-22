// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDocumentPagesCallBudget,
  DOCUMENT_PAGES_TURN_LIMIT_MESSAGE,
  DocumentPagesExecutionRuntime,
  resetDocumentPagesCallBudgetForTest,
} from './index';

describe('DocumentPagesExecutionRuntime', () => {
  const enqueueRender = vi.fn();
  const findAccessibleFile = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetDocumentPagesCallBudgetForTest();
  });

  afterEach(() => {
    resetDocumentPagesCallBudgetForTest();
  });

  describe('partial recoverability', () => {
    const runtime = new DocumentPagesExecutionRuntime({ enqueueRender, findAccessibleFile });

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

  describe('tiles fallback', () => {
    const runtime = new DocumentPagesExecutionRuntime({ enqueueRender, findAccessibleFile });

    it('falls back to the page PNG when zoom is tiles but the page has no tiles', async () => {
      findAccessibleFile.mockResolvedValue({
        fileType: 'application/pdf',
        id: 'file-1',
        metadata: {
          render: {
            pages: {
              '9': {
                chars: 40,
                png: 'files/render/file-1/pages/9.png',
                visual: true,
              },
            },
            status: 'ready',
          },
        },
        name: 'scan.pdf',
      });

      const result = await runtime.viewDocumentPages({
        fileId: 'file-1',
        pages: [9],
        zoom: 'tiles',
      });

      expect(result.success).toBe(true);
      expect(result.content).toBeTruthy();
      expect(result.content).toContain('<document_page_image');
      expect(result.content).toContain(
        '<document_page_image fileId="file-1" page="9" kind="page" key="files/render/file-1/pages/9.png"/>',
      );
      expect(result.content).not.toContain('kind="tile"');
      expect(result.state).toMatchObject({ markerCount: 1, pages: [9], zoom: 'tiles' });
    });

    it('falls back to the page PNG when tiles is an empty array', async () => {
      findAccessibleFile.mockResolvedValue({
        fileType: 'application/pdf',
        id: 'file-1',
        metadata: {
          render: {
            pages: {
              '9': {
                chars: 40,
                png: 'files/render/file-1/pages/9.png',
                tiles: [],
                visual: true,
              },
            },
            status: 'ready',
          },
        },
        name: 'scan.pdf',
      });

      const result = await runtime.viewDocumentPages({
        fileId: 'file-1',
        pages: [9],
        zoom: 'tiles',
      });

      expect(result.content).toContain('kind="page" key="files/render/file-1/pages/9.png"');
    });
  });

  describe('per-turn call budget', () => {
    it('returns the limit message on the 4th call for the same key', async () => {
      findAccessibleFile.mockResolvedValue({
        fileType: 'application/pdf',
        id: 'file-1',
        metadata: {
          render: {
            pages: { '1': { chars: 10, png: 'files/render/file-1/pages/1.png', visual: true } },
            status: 'ready',
          },
        },
        name: 'deck.pdf',
      });

      const runtime = new DocumentPagesExecutionRuntime({
        callBudget: createDocumentPagesCallBudget({ limit: 3, ttlMs: 60_000 }),
        callBudgetKey: 'turn:asst-1',
        enqueueRender,
        findAccessibleFile,
      });

      const results = [];
      for (let i = 0; i < 4; i += 1) {
        results.push(await runtime.viewDocumentPages({ fileId: 'file-1', pages: [1] }));
      }

      expect(
        results.slice(0, 3).every((result) => result.content?.includes('Requested page images')),
      ).toBe(true);
      expect(results[3].success).toBe(true);
      expect(results[3].content).toBe(DOCUMENT_PAGES_TURN_LIMIT_MESSAGE);
      expect(findAccessibleFile).toHaveBeenCalledTimes(3);
    });

    it('does not apply a limit when no callBudgetKey is set', async () => {
      findAccessibleFile.mockResolvedValue({
        fileType: 'application/pdf',
        id: 'file-1',
        metadata: {
          render: {
            pages: { '1': { chars: 10, png: 'files/render/file-1/pages/1.png', visual: true } },
            status: 'ready',
          },
        },
        name: 'deck.pdf',
      });

      const runtime = new DocumentPagesExecutionRuntime({ enqueueRender, findAccessibleFile });

      for (let i = 0; i < 4; i += 1) {
        const result = await runtime.viewDocumentPages({ fileId: 'file-1', pages: [1] });
        expect(result.content).toContain('Requested page images');
      }
    });
  });
});

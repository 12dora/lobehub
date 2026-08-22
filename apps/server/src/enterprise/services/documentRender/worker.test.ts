// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileModel } from '@/database/models/file';
import type * as pdfPageImagesModule from '@/server/modules/ModelRuntime/pdfPageImages';
import { renderPdfPagesToPng } from '@/server/modules/ModelRuntime/pdfPageImages';
import { DOCUMENT_RENDER_DEFAULTS } from '@/types/platform/documentRenderSettings';

import {
  getEffectiveDocumentRenderSettings,
  isDocumentRenderConfigured,
} from '../documentRenderSettings';
import type * as artifactsModule from './artifacts';
import type * as classifyModule from './classify';
import { classifyDocument } from './classify';
import { convertToPdf } from './gotenbergClient';
import type * as queueModule from './queue';
import { clampJobTimeoutMs, heartbeatIntervalMs, processClaimedDocumentRenderJob } from './worker';

const uploadBuffer = vi.fn();
const getFileByteArray = vi.fn();
const complete = vi.fn();
const fail = vi.fn();
const checkpoint = vi.fn();
const heartbeat = vi.fn();
const updateSet = vi.fn();
const returning = vi.fn();

vi.mock('../documentRenderSettings', () => ({
  getEffectiveDocumentRenderSettings: vi.fn(),
  isDocumentRenderConfigured: vi.fn((settings: { endpoint?: string }) =>
    Boolean(settings.endpoint),
  ),
}));

vi.mock('@/database/models/file', () => ({
  FileModel: { getFileById: vi.fn() },
}));

vi.mock('@/database/models/platform/job', () => ({
  PlatformJobModel: vi.fn().mockImplementation(() => ({
    checkpoint,
    complete,
    fail,
    heartbeat,
  })),
}));

vi.mock('@/server/modules/S3', () => ({
  createFileS3: vi.fn(async () => ({
    deleteFiles: vi.fn(),
    getFileByteArray,
    listObjectKeysByPrefix: vi.fn(async () => []),
    uploadBuffer,
  })),
}));

vi.mock('@/server/enterprise/services/moduleSettings', () => ({
  isModuleEnabled: vi.fn(async () => true),
}));

vi.mock('./classify', async (importOriginal) => {
  const actual = await importOriginal<typeof classifyModule>();
  return { ...actual, classifyDocument: vi.fn() };
});

vi.mock('./gotenbergClient', () => ({
  convertToPdf: vi.fn(),
  probeGotenberg: vi.fn(),
}));

vi.mock('./figures', () => ({
  extractOoxmlFigures: vi.fn(async () => [
    { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), ext: 'png', mimeType: 'image/png', page: 1 },
  ]),
}));

vi.mock('./artifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof artifactsModule>();
  return {
    ...actual,
    composeContactSheet: vi.fn(async () => ({
      height: 44,
      pages: [1],
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      width: 44,
    })),
    uploadImageArtifact: vi.fn(),
    uploadPdfArtifact: vi.fn(async () => 'files/render/f1/source.pdf'),
    uploadPngArtifact: vi.fn(),
  };
});

vi.mock('@/server/modules/ModelRuntime/pdfPageImages', async (importOriginal) => {
  const actual = await importOriginal<typeof pdfPageImagesModule>();
  return {
    ...actual,
    renderPdfPagesToPng: vi.fn(async (_bytes, opts) => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
      if (opts?.onPage) {
        await opts.onPage({
          height: 10,
          kind: 'page',
          page: 1,
          png,
          thumb: png,
          thumbHeight: 10,
          thumbWidth: 10,
          width: 10,
        });
      }
      return opts?.retainResults === false ? [] : [{ png }];
    }),
  };
});

vi.mock('./queue', async (importOriginal) => {
  const actual = await importOriginal<typeof queueModule>();
  return {
    ...actual,
    clearDocumentRenderTempDir: vi.fn(async () => undefined),
  };
});

const settings = {
  ...DOCUMENT_RENDER_DEFAULTS,
  concurrency: 2,
  endpoint: 'http://document-render:3000',
  revision: 1,
  source: 'db' as const,
};

const file = {
  fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  id: 'file-1',
  metadata: {},
  name: 'notes.docx',
  size: 1024,
  url: 'files/abc.docx',
};

const ctx = {
  db: {
    update: vi.fn(() => ({
      set: updateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({ returning }),
      }),
    })),
  },
  job: { id: 'job-1', input: { fileId: 'file-1' } },
  spec: { leaseMs: 180_000 },
  workerId: 'worker-1',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue(settings);
  vi.mocked(isDocumentRenderConfigured).mockReturnValue(true);
  vi.mocked(FileModel.getFileById).mockResolvedValue(file as never);
  getFileByteArray.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  complete.mockResolvedValue({ id: 'job-1' });
  fail.mockResolvedValue({ id: 'job-1' });
  checkpoint.mockResolvedValue({ id: 'job-1' });
  heartbeat.mockResolvedValue({ id: 'job-1' });
  returning.mockResolvedValue([{ id: 'file-1', metadata: { render: { status: 'pending' } } }]);
  updateSet.mockReturnValue({
    where: vi.fn().mockReturnValue({ returning }),
  });
});

describe('clampJobTimeoutMs / heartbeatIntervalMs', () => {
  it('clamps the job timeout to leaseMs - 15s', () => {
    expect(clampJobTimeoutMs(120, 180_000)).toBe(120_000);
    expect(clampJobTimeoutMs(900, 180_000)).toBe(165_000);
    expect(heartbeatIntervalMs(180_000)).toBe(60_000);
  });
});

describe('processClaimedDocumentRenderJob', () => {
  it('skips T0 files and completes the job', async () => {
    vi.mocked(classifyDocument).mockResolvedValue({
      kind: 'docx',
      mediaCount: 0,
      reason: 'no media entries',
      tier: 'T0',
    });
    await processClaimedDocumentRenderJob(ctx);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        resultSummary: expect.objectContaining({ status: 'skipped' }),
      }),
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it('extracts figures for T1 and marks ready', async () => {
    vi.mocked(classifyDocument).mockResolvedValue({
      kind: 'docx',
      mediaCount: 1,
      reason: 'mediaCount 1',
      tier: 'T1',
    });
    await processClaimedDocumentRenderJob(ctx);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.objectContaining({ status: 'ready' }),
      }),
    );
  });

  it('keeps T1 figures and fails retryably when T2 sidecar is unavailable', async () => {
    vi.mocked(classifyDocument).mockResolvedValue({
      kind: 'pptx',
      mediaCount: 4,
      reason: 'pptxAlwaysT2',
      tier: 'T2',
    });
    vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue({
      ...settings,
      endpoint: undefined,
    });
    vi.mocked(isDocumentRenderConfigured).mockReturnValue(false);
    await processClaimedDocumentRenderJob(ctx);
    expect(convertToPdf).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'sidecar unavailable', retryable: true }),
        jobId: 'job-1',
      }),
    );
  });

  it('converts office T2 via Gotenberg then rasterizes without retaining page buffers', async () => {
    vi.mocked(classifyDocument).mockResolvedValue({
      kind: 'pptx',
      mediaCount: 4,
      pageCount: 1,
      pages: [{ chars: 40, page: 1, visual: true }],
      reason: 'pptxAlwaysT2',
      tier: 'T2',
    });
    vi.mocked(convertToPdf).mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    await processClaimedDocumentRenderJob(ctx);
    expect(convertToPdf).toHaveBeenCalledWith(
      'http://document-render:3000',
      expect.objectContaining({
        filename: 'notes.docx',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(renderPdfPagesToPng).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ retainResults: false }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.objectContaining({ status: 'ready' }),
      }),
    );
  });

  it('aborts without complete/ready when checkpoint loses the lease', async () => {
    vi.mocked(classifyDocument).mockResolvedValue({
      kind: 'pptx',
      mediaCount: 4,
      pageCount: 1,
      pages: [{ chars: 40, page: 1, visual: true }],
      reason: 'pptxAlwaysT2',
      tier: 'T2',
    });
    vi.mocked(convertToPdf).mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    checkpoint.mockResolvedValue(null);
    await processClaimedDocumentRenderJob(ctx);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it('stops and skips the job when the files row is deleted mid-render', async () => {
    vi.mocked(classifyDocument).mockResolvedValue({
      kind: 'docx',
      mediaCount: 1,
      reason: 'mediaCount 1',
      tier: 'T1',
    });
    returning.mockResolvedValue([]);
    await processClaimedDocumentRenderJob(ctx);
    expect(fail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.objectContaining({ status: 'skipped' }),
      }),
    );
  });

  it('logs and does not throw when complete returns null', async () => {
    vi.mocked(classifyDocument).mockResolvedValue({
      kind: 'docx',
      mediaCount: 0,
      reason: 'no media entries',
      tier: 'T0',
    });
    complete.mockResolvedValue(null);
    await expect(processClaimedDocumentRenderJob(ctx)).resolves.toBeUndefined();
    expect(complete).toHaveBeenCalled();
  });

  it('heartbeats independently of page completion during Gotenberg conversion', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(classifyDocument).mockResolvedValue({
        kind: 'pptx',
        mediaCount: 4,
        pageCount: 1,
        pages: [{ chars: 40, page: 1, visual: true }],
        reason: 'pptxAlwaysT2',
        tier: 'T2',
      });
      let resolveConvert!: (value: Uint8Array) => void;
      let convertStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        convertStarted = resolve;
      });
      vi.mocked(convertToPdf).mockImplementation(
        () =>
          new Promise((resolve) => {
            convertStarted();
            resolveConvert = resolve;
          }),
      );
      const pending = processClaimedDocumentRenderJob(ctx);
      await started;
      await vi.advanceTimersByTimeAsync(heartbeatIntervalMs(180_000));
      expect(heartbeat).toHaveBeenCalled();
      resolveConvert(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

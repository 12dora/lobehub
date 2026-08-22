// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileModel } from '@/database/models/file';
import type * as pdfPageImagesModule from '@/server/modules/ModelRuntime/pdfPageImages';
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
import { processClaimedDocumentRenderJob } from './worker';

const uploadBuffer = vi.fn();
const getFileByteArray = vi.fn();
const complete = vi.fn();
const fail = vi.fn();
const checkpoint = vi.fn();
const updateSet = vi.fn();

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
  })),
}));

vi.mock('@/server/modules/S3', () => ({
  createFileS3: vi.fn(async () => ({
    deleteFiles: vi.fn(),
    getFileByteArray,
    listObjectKeysByPrefix: vi.fn(),
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
      return [];
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
        where: vi.fn().mockResolvedValue([]),
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
  updateSet.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
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

  it('falls back to T1 figures when T2 office sidecar is unavailable', async () => {
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
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.objectContaining({ status: 'partial' }),
      }),
    );
  });

  it('converts office T2 via Gotenberg then rasterizes with mocked S3/pdfjs', async () => {
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
    expect(convertToPdf).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.objectContaining({ status: 'ready' }),
      }),
    );
  });
});

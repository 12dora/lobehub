// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileItem } from '@/database/schemas';
import { DOCUMENT_RENDER_DEFAULTS } from '@/types/platform/documentRenderSettings';

import {
  getEffectiveDocumentRenderSettings,
  isDocumentRenderConfigured,
} from '../documentRenderSettings';
import { uploadPdfArtifact } from './artifacts';
import { convertToPdf } from './gotenbergClient';
import { getDocumentPreview, resetDocumentPreviewFlightsForTest } from './preview';

const s3Mocks = vi.hoisted(() => ({
  createPreSignedUrlForPreview: vi.fn(),
  getFileByteArray: vi.fn(),
  getFileMetadata: vi.fn(),
}));

vi.mock('../documentRenderSettings', () => ({
  getEffectiveDocumentRenderSettings: vi.fn(),
  isDocumentRenderConfigured: vi.fn((settings: { endpoint?: string }) =>
    Boolean(settings.endpoint),
  ),
}));

vi.mock('@/server/enterprise/services/moduleSettings', () => ({
  isModuleEnabled: vi.fn(async () => true),
}));

vi.mock('@/server/modules/S3', () => ({
  createFileS3: vi.fn(async () => s3Mocks),
}));

vi.mock('./gotenbergClient', () => ({
  convertToPdf: vi.fn(),
}));

vi.mock('./artifacts', () => ({
  deleteDocumentRenderArtifacts: vi.fn(),
  uploadPdfArtifact: vi.fn(),
}));

const { isModuleEnabled } = await import('@/server/enterprise/services/moduleSettings');

const settings = {
  ...DOCUMENT_RENDER_DEFAULTS,
  concurrency: 2,
  endpoint: 'http://document-render:3000',
  revision: 1,
  source: 'db' as const,
};

const flattenSql = (value: unknown, seen: Set<unknown> = new Set()): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  if (typeof value === 'object') {
    if (seen.has(value)) return '';
    seen.add(value);
  }
  if (Array.isArray(value)) return value.map((item) => flattenSql(item, seen)).join(' ');
  const record = value as Record<string, unknown>;
  if ('queryChunks' in record) return flattenSql(record.queryChunks, seen);
  if (typeof record.value === 'string' || typeof record.value === 'number') {
    return String(record.value);
  }
  return Object.values(record)
    .map((item) => flattenSql(item, seen))
    .join(' ');
};

const officeFile = (overrides: Partial<FileItem> = {}): FileItem =>
  ({
    fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    id: 'file-1',
    metadata: {},
    name: 'notes.docx',
    size: 1024,
    url: 'files/abc.docx',
    ...overrides,
  }) as FileItem;

const mockDb = () => {
  const updateSet = vi.fn();
  const returning = vi.fn(async () => [
    {
      id: 'file-1',
      metadata: { render: { pdf: 'files/render/file-1/source.pdf', status: 'ready' } },
    },
  ]);
  const db = {
    update: vi.fn(() => ({
      set: updateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({ returning }),
      }),
    })),
  };
  return { db, returning, updateSet };
};

const previewOf = (file: FileItem, db: unknown = mockDb().db) =>
  getDocumentPreview({ db: db as never, file, userId: 'user-1' });

beforeEach(() => {
  vi.clearAllMocks();
  resetDocumentPreviewFlightsForTest();
  vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue(settings);
  vi.mocked(isDocumentRenderConfigured).mockReturnValue(true);
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  s3Mocks.createPreSignedUrlForPreview.mockResolvedValue('https://signed.example/source.pdf');
  s3Mocks.getFileByteArray.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  s3Mocks.getFileMetadata.mockResolvedValue({ contentLength: 100, contentType: 'application/pdf' });
  vi.mocked(convertToPdf).mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  vi.mocked(uploadPdfArtifact).mockResolvedValue('files/render/file-1/source.pdf');
});

describe('getDocumentPreview', () => {
  it('returns unsupported for non-office kinds and pdf', async () => {
    await expect(
      previewOf(officeFile({ fileType: 'application/pdf', name: 'scan.pdf' })),
    ).resolves.toEqual({ status: 'unsupported' });
    await expect(
      previewOf(officeFile({ fileType: 'image/png', name: 'photo.png' })),
    ).resolves.toEqual({ status: 'unsupported' });
    expect(convertToPdf).not.toHaveBeenCalled();
  });

  it('returns ready from an existing pdf key without converting', async () => {
    const file = officeFile({
      metadata: {
        render: {
          pageCount: 4,
          pdf: 'files/render/file-1/source.pdf',
          status: 'ready',
          tier: 'T2',
        },
      },
    });

    await expect(previewOf(file)).resolves.toEqual({
      pageCount: 4,
      status: 'ready',
      url: 'https://signed.example/source.pdf',
    });
    expect(s3Mocks.getFileMetadata).toHaveBeenCalledWith('files/render/file-1/source.pdf');
    expect(s3Mocks.createPreSignedUrlForPreview).toHaveBeenCalledWith(
      'files/render/file-1/source.pdf',
      15 * 60,
    );
    expect(convertToPdf).not.toHaveBeenCalled();
  });

  it('returns unavailable when the sidecar is not configured', async () => {
    vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue({
      ...settings,
      endpoint: undefined,
    });
    vi.mocked(isDocumentRenderConfigured).mockReturnValue(false);

    await expect(previewOf(officeFile())).resolves.toEqual({ status: 'unavailable' });
    expect(convertToPdf).not.toHaveBeenCalled();
  });

  it('converts on demand, writes pdf into metadata, and returns a presigned url', async () => {
    const { db, updateSet } = mockDb();
    const file = officeFile({
      metadata: { render: { status: 'ready', tier: 'T1' } },
    });

    await expect(previewOf(file, db)).resolves.toEqual({
      status: 'ready',
      url: 'https://signed.example/source.pdf',
    });
    expect(convertToPdf).toHaveBeenCalledWith(
      'http://document-render:3000',
      expect.objectContaining({ filename: 'notes.docx', timeoutMs: 30_000 }),
    );
    expect(uploadPdfArtifact).toHaveBeenCalledWith('file-1', expect.any(Uint8Array));
    expect(flattenSql(updateSet.mock.calls)).toContain('"pdf":"files/render/file-1/source.pdf"');
    expect(flattenSql(updateSet.mock.calls)).not.toContain('"status"');
  });

  it('shares one conversion across concurrent preview requests', async () => {
    const { db } = mockDb();
    const file = officeFile();
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

    const first = previewOf(file, db);
    await started;
    const second = previewOf(file, db);
    expect(convertToPdf).toHaveBeenCalledTimes(1);
    resolveConvert(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    await expect(first).resolves.toMatchObject({ status: 'ready' });
    await expect(second).resolves.toMatchObject({ status: 'ready' });
    expect(convertToPdf).toHaveBeenCalledTimes(1);
    expect(uploadPdfArtifact).toHaveBeenCalledTimes(1);
  });

  it('never presigns a client-supplied pdf key — the key is derived from the file id', async () => {
    const file = officeFile({
      metadata: {
        render: { pdf: 'files/render/victim-file/source.pdf', status: 'ready', tier: 'T2' },
      },
    });

    await expect(previewOf(file)).resolves.toMatchObject({ status: 'ready' });
    expect(s3Mocks.getFileMetadata).toHaveBeenCalledWith('files/render/file-1/source.pdf');
    expect(s3Mocks.createPreSignedUrlForPreview).toHaveBeenCalledWith(
      'files/render/file-1/source.pdf',
      15 * 60,
    );
    expect(s3Mocks.getFileMetadata).not.toHaveBeenCalledWith('files/render/victim-file/source.pdf');
  });

  it('serves a cached failure during the cooldown instead of reconverting', async () => {
    vi.mocked(convertToPdf).mockRejectedValue(new Error('Gotenberg convert failed: HTTP 500'));

    await expect(previewOf(officeFile())).resolves.toMatchObject({ status: 'failed' });
    await expect(previewOf(officeFile())).resolves.toMatchObject({ status: 'failed' });
    expect(convertToPdf).toHaveBeenCalledTimes(1);
  });

  it('caps concurrent on-demand conversions and answers pending beyond the cap', async () => {
    const releases: Array<() => void> = [];
    vi.mocked(convertToPdf).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(new Uint8Array([1])));
        }),
    );

    const first = previewOf(officeFile({ id: 'file-a' }));
    const second = previewOf(officeFile({ id: 'file-b' }));
    await Promise.resolve();
    await expect(previewOf(officeFile({ id: 'file-c' }))).resolves.toEqual({ status: 'pending' });
    expect(convertToPdf).toHaveBeenCalledTimes(2);
    for (const release of releases) release();
    await Promise.allSettled([first, second]);
  });

  it('returns failed without leaking the sidecar endpoint', async () => {
    vi.mocked(convertToPdf).mockRejectedValue(
      new Error(
        'Gotenberg convert failed: HTTP 503 at http://document-render:3000/forms/libreoffice/convert',
      ),
    );

    const result = await previewOf(officeFile());
    expect(result).toEqual({ error: 'conversion failed (HTTP 503)', status: 'failed' });
    expect(result.error).not.toContain('document-render');
    expect(result.error).not.toMatch(/https?:\/\//i);
  });

  it('returns pending when a T2 render job is already in flight', async () => {
    const file = officeFile({
      metadata: {
        render: {
          status: 'pending',
          tier: 'T2',
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await expect(previewOf(file)).resolves.toEqual({ status: 'pending' });
    expect(convertToPdf).not.toHaveBeenCalled();
  });
});

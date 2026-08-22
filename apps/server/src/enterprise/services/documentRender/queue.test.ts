// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileModel } from '@/database/models/file';
import { PlatformJobModel } from '@/database/models/platform/job';
import { DOCUMENT_RENDER_DEFAULTS } from '@/types/platform/documentRenderSettings';

import { getEffectiveDocumentRenderSettings } from '../documentRenderSettings';
import {
  cancelDocumentRenderJob,
  enqueueDocumentRenderJob,
  getDocumentRenderQueueStats,
  retryDocumentRenderJob,
} from './queue';

vi.mock('../documentRenderSettings', () => ({
  getEffectiveDocumentRenderSettings: vi.fn(),
  isDocumentRenderConfigured: (settings: { endpoint?: string }) => Boolean(settings.endpoint),
}));

vi.mock('@/database/models/file', () => ({
  FileModel: {
    getFileById: vi.fn(),
  },
}));

const enqueue = vi.fn();
const cancel = vi.fn();
const findById = vi.fn();

vi.mock('@/database/models/platform/job', () => ({
  PlatformJobModel: vi.fn().mockImplementation(() => ({
    cancel,
    enqueue,
    findById,
  })),
}));

const settings = {
  ...DOCUMENT_RENDER_DEFAULTS,
  concurrency: 2,
  endpoint: 'http://document-render:3000',
  revision: 0,
  source: 'env' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue(settings);
  enqueue.mockResolvedValue({ created: true, job: { id: 'job-1' } });
  cancel.mockResolvedValue({ id: 'job-1' });
  findById.mockResolvedValue({ id: 'job-1', type: 'platform.document.render.v1' });
});

describe('enqueueDocumentRenderJob', () => {
  const dbWithUpdate = () =>
    ({
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    }) as never;

  it('returns null for unsupported types', async () => {
    vi.mocked(FileModel.getFileById).mockResolvedValue({
      fileType: 'image/png',
      id: 'f1',
      name: 'pic.png',
    } as never);
    await expect(enqueueDocumentRenderJob({} as never, { fileId: 'f1' })).resolves.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns null when trigger is onDemand and force is not set', async () => {
    vi.mocked(FileModel.getFileById).mockResolvedValue({
      fileType: 'application/pdf',
      id: 'f1',
      name: 'doc.pdf',
    } as never);
    vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue({
      ...settings,
      trigger: 'onDemand',
    });
    await expect(enqueueDocumentRenderJob({} as never, { fileId: 'f1' })).resolves.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues with idempotency key document-render:<fileId>', async () => {
    vi.mocked(FileModel.getFileById).mockResolvedValue({
      fileType: 'application/pdf',
      id: 'file-9',
      name: 'doc.pdf',
    } as never);
    const result = await enqueueDocumentRenderJob(dbWithUpdate(), {
      fileId: 'file-9',
      requestedBy: 'user-1',
    });
    expect(result).toEqual({ created: true, jobId: 'job-1' });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'document-render:file-9',
        input: { ext: 'pdf', fileId: 'file-9' },
        maxAttempts: 3,
        requestedBy: 'user-1',
        type: 'platform.document.render.v1',
      }),
    );
  });

  it('enqueues onDemand when force is true', async () => {
    vi.mocked(FileModel.getFileById).mockResolvedValue({
      fileType: 'application/pdf',
      id: 'f1',
      name: 'doc.pdf',
    } as never);
    vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue({
      ...settings,
      trigger: 'onDemand',
    });
    await expect(
      enqueueDocumentRenderJob(dbWithUpdate(), { fileId: 'f1', force: true }),
    ).resolves.toEqual({ created: true, jobId: 'job-1' });
    expect(enqueue).toHaveBeenCalled();
  });

  it('requeues an existing succeeded job by idempotency key when force and status is partial', async () => {
    enqueue.mockResolvedValue({ created: false, job: { id: 'job-1', status: 'succeeded' } });
    vi.mocked(FileModel.getFileById).mockResolvedValue({
      fileType: 'application/pdf',
      id: 'file-9',
      metadata: { render: { error: 'sidecar unavailable', status: 'partial' } },
      name: 'doc.pdf',
    } as never);
    const returning = vi.fn().mockResolvedValue([{ id: 'job-1' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const result = await enqueueDocumentRenderJob({ update } as never, {
      fileId: 'file-9',
      force: true,
    });
    expect(result).toEqual({ created: false, jobId: 'job-1' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ attempt: 0, status: 'pending' }));
    expect(update).toHaveBeenCalled();
  });
});

describe('retryDocumentRenderJob / cancelDocumentRenderJob', () => {
  it('retry updates failed/dead rows to pending', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'job-1' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const db = { update } as never;
    await expect(retryDocumentRenderJob(db, 'job-1')).resolves.toEqual({ ok: true });
    expect(update).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ attempt: 0, status: 'pending' }));
  });

  it('cancel returns ok when the job exists and is cancellable', async () => {
    await expect(cancelDocumentRenderJob({} as never, 'job-1')).resolves.toEqual({ ok: true });
    expect(PlatformJobModel).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith('job-1');
  });
});

describe('getDocumentRenderQueueStats', () => {
  it('aggregates pending/running/24h counts and recent rows', async () => {
    const pending = [{ count: 2 }];
    const running = [{ count: 1 }];
    const failed = [{ count: 3 }];
    const succeeded = [
      { durationMs: 100, finishedAt: new Date(), startedAt: new Date() },
      { durationMs: 400, finishedAt: new Date(), startedAt: new Date() },
    ];
    const recent = [
      {
        finishedAt: new Date('2026-01-01T00:00:00.000Z'),
        id: 'r1',
        input: { ext: 'pptx', fileId: 'f1' },
        lastError: null,
        resultSummary: { durationMs: 100, pages: 4 },
        status: 'succeeded',
      },
    ];

    const selectSeq = [pending, running, failed, succeeded, recent];
    const makeQuery = (rows: unknown[]) => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve(rows), {
            limit: async () => rows,
            orderBy: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
          }),
      }),
    });
    const db = {
      select: vi.fn(() => makeQuery(selectSeq.shift() ?? [])),
    };

    const stats = await getDocumentRenderQueueStats(db as never);
    expect(stats.pending).toBe(2);
    expect(stats.running).toBe(1);
    expect(stats.failed24h).toBe(3);
    expect(stats.succeeded24h).toBe(2);
    expect(stats.avgMs).toBe(250);
    expect(stats.p95Ms).toBe(400);
    expect(stats.recent).toEqual([
      {
        durationMs: 100,
        error: null,
        ext: 'pptx',
        fileId: 'f1',
        finishedAt: '2026-01-01T00:00:00.000Z',
        id: 'r1',
        pages: 4,
        status: 'succeeded',
      },
    ]);
  });
});

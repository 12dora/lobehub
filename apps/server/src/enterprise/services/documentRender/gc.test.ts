// @vitest-environment node
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DOCUMENT_RENDER_DEFAULTS } from '@/types/platform/documentRenderSettings';

import { getEffectiveDocumentRenderSettings } from '../documentRenderSettings';
import { deleteDocumentRenderArtifacts } from './artifacts';
import { getDocumentRenderMaintenanceSummary, processClaimedDocumentRenderGcJob } from './gc';
import { documentRenderTempRoot } from './queue';

const complete = vi.fn();
const fail = vi.fn();
const heartbeat = vi.fn();
const listObjectsByPrefix = vi.fn();
const deleteFiles = vi.fn();

vi.mock('../documentRenderSettings', () => ({
  getEffectiveDocumentRenderSettings: vi.fn(),
}));

vi.mock('@/database/models/platform/job', () => ({
  PlatformJobModel: vi.fn().mockImplementation(() => ({
    complete,
    fail,
    heartbeat,
  })),
}));

vi.mock('@/server/modules/S3', () => ({
  createFileS3: vi.fn(),
}));

vi.mock('./artifacts', () => ({
  deleteDocumentRenderArtifacts: vi.fn(async () => undefined),
}));

vi.mock('./queue', () => ({
  documentRenderTempRoot: vi.fn(),
}));

const { createFileS3 } = await import('@/server/modules/S3');

const settings = {
  ...DOCUMENT_RENDER_DEFAULTS,
  endpoint: 'http://document-render:3000',
  revision: 0,
  source: 'env' as const,
};

const ctxOf = (db: unknown) =>
  ({
    db,
    job: { id: 'job-gc', input: {} },
    spec: { leaseMs: 15 * 60_000, workerName: 'documentRenderGc' },
    workerId: 'worker-1',
  }) as never;

const selectDb = (results: unknown[][]) => {
  const queue = [...results];
  return {
    select: vi.fn(() => {
      const rows = queue.shift() ?? [];
      return {
        from: () => ({
          where: () =>
            Object.assign(Promise.resolve(rows), {
              limit: async () => rows,
              orderBy: () => ({ limit: async () => rows }),
            }),
        }),
      };
    }),
    update: vi.fn(() => ({
      set: () => ({
        where: async () => undefined,
      }),
    })),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue(settings);
  vi.mocked(createFileS3).mockResolvedValue({ deleteFiles, listObjectsByPrefix } as never);
  listObjectsByPrefix.mockResolvedValue([]);
  deleteFiles.mockResolvedValue(undefined);
  complete.mockResolvedValue({ id: 'job-gc' });
  fail.mockResolvedValue({ id: 'job-gc' });
  heartbeat.mockResolvedValue({ id: 'job-gc' });
  vi.mocked(documentRenderTempRoot).mockReturnValue(path.join(tmpdir(), 'missing-aihub-render'));
});

describe('processClaimedDocumentRenderGcJob', () => {
  it('completes with zeros and skipped when object storage is not configured', async () => {
    vi.mocked(createFileS3).mockRejectedValue(new Error('S3 environment variables are not set'));
    await processClaimedDocumentRenderGcJob(ctxOf({}));
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-gc',
        resultSummary: expect.objectContaining({
          artifactBytes: 0,
          artifactObjects: 0,
          expiredFiles: 0,
          orphanBytes: 0,
          orphanObjects: 0,
          skipped: true,
          tempDirBytes: 0,
        }),
        workerId: 'worker-1',
      }),
    );
    expect(fail).not.toHaveBeenCalled();
    expect(deleteDocumentRenderArtifacts).not.toHaveBeenCalled();
  });

  it('skips retention when retentionDays is 0', async () => {
    await processClaimedDocumentRenderGcJob(ctxOf(selectDb([])));
    expect(deleteDocumentRenderArtifacts).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.objectContaining({ expiredFiles: 0 }),
      }),
    );
    const summary = complete.mock.calls[0]![0].resultSummary as { skipped?: boolean };
    expect(summary.skipped).toBeUndefined();
  });

  it('expires ready/partial artifacts older than retentionDays', async () => {
    vi.mocked(getEffectiveDocumentRenderSettings).mockResolvedValue({
      ...settings,
      retentionDays: 7,
    });
    const db = selectDb([[{ id: 'file-old' }]]);
    await processClaimedDocumentRenderGcJob(ctxOf(db));
    expect(deleteDocumentRenderArtifacts).toHaveBeenCalledWith(['file-old']);
    expect(db.update).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.objectContaining({ expiredFiles: 1 }),
      }),
    );
  });

  it('deletes orphan prefixes and reports remaining artifact totals', async () => {
    listObjectsByPrefix.mockResolvedValue([
      { key: 'files/render/alive/pages/1.png', size: 40 },
      { key: 'files/render/gone/pages/1.png', size: 10 },
      { key: 'files/render/gone/thumbs/1.png', size: 5 },
    ]);
    const db = selectDb([[{ id: 'alive' }]]);
    await processClaimedDocumentRenderGcJob(ctxOf(db));
    expect(deleteFiles).toHaveBeenCalledWith([
      'files/render/gone/pages/1.png',
      'files/render/gone/thumbs/1.png',
    ]);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.objectContaining({
          artifactBytes: 40,
          artifactObjects: 1,
          orphanBytes: 15,
          orphanObjects: 2,
        }),
      }),
    );
  });

  it('fails the job as terminal when S3 listing throws', async () => {
    listObjectsByPrefix.mockRejectedValue(new Error('S3 unavailable'));
    await processClaimedDocumentRenderGcJob(ctxOf(selectDb([])));
    expect(fail).toHaveBeenCalledWith({
      error: { message: 'S3 unavailable' },
      jobId: 'job-gc',
      terminal: true,
      workerId: 'worker-1',
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('drops temp subdirectories older than one hour and reports remaining bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aihub-render-gc-'));
    vi.mocked(documentRenderTempRoot).mockReturnValue(root);
    try {
      const staleDir = path.join(root, 'stale-job');
      await mkdir(staleDir);
      await writeFile(path.join(staleDir, 'left.bin'), Buffer.alloc(12));
      const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(staleDir, staleAt, staleAt);

      const liveDir = path.join(root, 'live-job');
      await mkdir(liveDir);
      await writeFile(path.join(liveDir, 'keep.bin'), Buffer.alloc(8));

      await processClaimedDocumentRenderGcJob(ctxOf(selectDb([])));
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          resultSummary: expect.objectContaining({ tempDirBytes: 8 }),
        }),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('getDocumentRenderMaintenanceSummary', () => {
  it('returns nulls when no GC job has run', async () => {
    await expect(getDocumentRenderMaintenanceSummary(selectDb([[]]) as never)).resolves.toEqual({
      artifactBytes: null,
      artifactObjects: null,
      expiredFiles: null,
      jobStatus: null,
      lastError: null,
      lastRunAt: null,
      orphanBytes: null,
      orphanObjects: null,
      tempDirBytes: null,
    });
  });

  it('maps the latest GC row resultSummary and timestamps', async () => {
    const finishedAt = new Date('2026-08-22T12:00:00.000Z');
    const db = selectDb([
      [
        {
          createdAt: new Date('2026-08-22T11:00:00.000Z'),
          finishedAt,
          lastError: { message: 'boom' },
          resultSummary: {
            artifactBytes: 100,
            artifactObjects: 4,
            expiredFiles: 2,
            orphanBytes: 9,
            orphanObjects: 3,
            tempDirBytes: 7,
          },
          startedAt: new Date('2026-08-22T11:30:00.000Z'),
          status: 'failed',
        },
      ],
    ]);
    await expect(getDocumentRenderMaintenanceSummary(db as never)).resolves.toEqual({
      artifactBytes: 100,
      artifactObjects: 4,
      expiredFiles: 2,
      jobStatus: 'failed',
      lastError: 'boom',
      lastRunAt: finishedAt.toISOString(),
      orphanBytes: 9,
      orphanObjects: 3,
      tempDirBytes: 7,
    });
  });
});

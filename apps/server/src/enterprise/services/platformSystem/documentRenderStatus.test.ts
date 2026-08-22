// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDocumentRenderMaintenanceSummary,
  getDocumentRenderQueueStats,
} from '@/server/enterprise/services/documentRender';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import { getDocumentFeedStats } from '@/server/modules/ModelRuntime/documentFeedStats';

import { probeDocumentRenderHealth } from './documentRenderProbe';
import { getDocumentRenderStatus } from './documentRenderStatus';
import { getLiveInfraHealth } from './infraHealthMemo';

vi.mock('@/server/enterprise/services/moduleSettings', () => ({
  isModuleEnabled: vi.fn(),
}));

vi.mock('@/server/enterprise/services/documentRender', () => ({
  getDocumentRenderMaintenanceSummary: vi.fn(),
  getDocumentRenderQueueStats: vi.fn(),
}));

vi.mock('@/server/modules/ModelRuntime/documentFeedStats', () => ({
  getDocumentFeedStats: vi.fn(),
}));

vi.mock('./documentRenderProbe', () => ({
  probeDocumentRenderHealth: vi.fn(),
}));

vi.mock('./infraHealthMemo', () => ({
  getLiveInfraHealth: vi.fn(),
}));

const checkedAt = new Date('2026-08-22T12:00:00.000Z');
const db = {} as never;

const queue = {
  avgMs: 8400,
  failed24h: 2,
  p95Ms: 12_000,
  pending: 1,
  recent: [
    {
      durationMs: 8400,
      error: null,
      ext: 'pptx',
      fileId: 'file_1',
      finishedAt: checkedAt.toISOString(),
      id: 'pjob_render1',
      pages: 15,
      status: 'succeeded',
    },
  ],
  running: 0,
  succeeded24h: 9,
};

const feed = {
  docsFed: 3,
  imagesFed: 11,
  pendingFallbacks: 1,
  pendingWaits: 2,
  requestsWithImages: 4,
  since: '2026-08-22T00:00:00.000Z',
  toolPageViews: 5,
};

const maintenance = {
  artifactBytes: 2048,
  artifactObjects: 12,
  expiredFiles: 1,
  jobStatus: 'succeeded',
  lastError: null,
  lastRunAt: checkedAt.toISOString(),
  orphanBytes: 0,
  orphanObjects: 0,
  tempDirBytes: 64,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(getDocumentRenderQueueStats).mockResolvedValue(queue);
  vi.mocked(getDocumentRenderMaintenanceSummary).mockResolvedValue(maintenance);
  vi.mocked(getDocumentFeedStats).mockReturnValue(feed);
  vi.mocked(getLiveInfraHealth).mockResolvedValue({
    documentRender: {
      configured: true,
      errorCategory: null,
      lastCheckedAt: checkedAt,
      latencyMs: 18,
      queuePending: 1,
      queueRunning: 0,
      status: 'healthy',
      version: '8.21.0',
    },
    keyManagement: { errorCategory: null, lastCheckedAt: checkedAt, status: 'disabled' },
    objectStorage: { errorCategory: null, lastCheckedAt: checkedAt, status: 'disabled' },
  });
});

describe('getDocumentRenderStatus', () => {
  it('reports a disabled sidecar when the module is off', async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    await expect(getDocumentRenderStatus(db, () => checkedAt)).resolves.toMatchObject({
      configured: false,
      feed,
      maintenance,
      moduleEnabled: false,
      sidecar: { status: 'disabled' },
    });
  });

  it('maps healthy memo health to sidecar up and ISO timestamps', async () => {
    const status = await getDocumentRenderStatus(db, () => checkedAt);
    expect(status).toMatchObject({
      configured: true,
      feed,
      maintenance,
      moduleEnabled: true,
      queue: {
        pending: 1,
        recent: [
          {
            ext: 'pptx',
            fileId: 'file_1',
            finishedAt: checkedAt.toISOString(),
            id: 'pjob_render1',
            pages: 15,
            status: 'succeeded',
          },
        ],
        running: 0,
      },
      sidecar: {
        checkedAt: checkedAt.toISOString(),
        latencyMs: 18,
        status: 'up',
        version: '8.21.0',
      },
    });
    expect(getLiveInfraHealth).toHaveBeenCalledWith(
      expect.objectContaining({ probeDocumentRender: expect.any(Function) }),
    );
  });

  it('maps configuration_incomplete health to unconfigured', async () => {
    vi.mocked(getLiveInfraHealth).mockResolvedValue({
      documentRender: {
        configured: false,
        errorCategory: 'configuration_incomplete',
        lastCheckedAt: checkedAt,
        queuePending: 0,
        queueRunning: 0,
        status: 'degraded',
      },
      keyManagement: { errorCategory: null, lastCheckedAt: checkedAt, status: 'disabled' },
      objectStorage: { errorCategory: null, lastCheckedAt: checkedAt, status: 'disabled' },
    });
    await expect(getDocumentRenderStatus(db, () => checkedAt)).resolves.toMatchObject({
      configured: false,
      sidecar: { status: 'unconfigured' },
    });
    expect(probeDocumentRenderHealth).not.toHaveBeenCalled();
  });
});

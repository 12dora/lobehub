import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminSystemService } from './adminSystem';

const mocks = vi.hoisted(() => ({
  cancelJob: vi.fn(),
  getInstanceRevisions: vi.fn(),
  getJobs: vi.fn(),
  getStatus: vi.fn(),
  retryJob: vi.fn(),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      system: {
        cancelJob: { mutate: mocks.cancelJob },
        getInstanceRevisions: { query: mocks.getInstanceRevisions },
        getJobs: { query: mocks.getJobs },
        getStatus: { query: mocks.getStatus },
        retryJob: { mutate: mocks.retryJob },
      },
    },
  },
}));

describe('Admin System service adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards read inputs to admin.system procedures', async () => {
    const status = { snapshotAt: new Date('2026-07-20T00:00:00.000Z') };
    const instances = { items: [], nextCursor: null };
    const jobs = { items: [], nextCursor: null };
    mocks.getStatus.mockResolvedValue(status);
    mocks.getInstanceRevisions.mockResolvedValue(instances);
    mocks.getJobs.mockResolvedValue(jobs);

    await expect(adminSystemService.getStatus()).resolves.toBe(status);
    await expect(adminSystemService.getInstanceRevisions({ limit: 20 })).resolves.toBe(instances);
    await expect(adminSystemService.getJobs({ cursor: 'next-page', limit: 20 })).resolves.toBe(
      jobs,
    );
    expect(mocks.getStatus).toHaveBeenCalledWith();
    expect(mocks.getInstanceRevisions).toHaveBeenCalledWith({ limit: 20 });
    expect(mocks.getJobs).toHaveBeenCalledWith({ cursor: 'next-page', limit: 20 });
  });

  it('forwards audited CAS mutation inputs without rewriting them', async () => {
    const shared = {
      expectedRevision: 3,
      jobId: 'pjob_0000000000000001',
      reason: 'operator verification',
      requestId: '00000000-0000-4000-8000-000000000001',
    };
    const cancelled = { ...shared, status: 'cancelled' };
    const retried = { ...shared, status: 'pending' };
    mocks.cancelJob.mockResolvedValue(cancelled);
    mocks.retryJob.mockResolvedValue(retried);

    await expect(
      adminSystemService.cancelJob({ ...shared, expectedStatus: 'running' }),
    ).resolves.toBe(cancelled);
    await expect(
      adminSystemService.retryJob({ ...shared, expectedStatus: 'failed' }),
    ).resolves.toBe(retried);
    expect(mocks.cancelJob).toHaveBeenCalledWith({ ...shared, expectedStatus: 'running' });
    expect(mocks.retryJob).toHaveBeenCalledWith({ ...shared, expectedStatus: 'failed' });
  });
});

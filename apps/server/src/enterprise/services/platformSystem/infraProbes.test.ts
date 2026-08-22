// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { probeObjectStorageHealth } from './infraProbes';

const completeS3 = {
  S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  S3_BUCKET: 'lobe-files',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('probeObjectStorageHealth', () => {
  it('times the live HeadBucket round-trip and reports the bucket, not credentials', async () => {
    const checkedAt = new Date('2026-08-23T00:00:00.000Z');
    const destroy = vi.fn();
    const send = vi.fn(async () => ({}));
    const result = await probeObjectStorageHealth(
      completeS3,
      () => ({ destroy, send }),
      () => checkedAt,
    );

    expect(result).toEqual({
      detail: 'S3 · lobe-files',
      errorCategory: null,
      lastCheckedAt: checkedAt,
      latencyMs: expect.any(Number),
      status: 'healthy',
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(send).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('keeps unconfigured storage without detail or latency', async () => {
    await expect(probeObjectStorageHealth({})).resolves.toEqual({
      errorCategory: null,
      lastCheckedAt: null,
      status: 'disabled',
    });
  });
});

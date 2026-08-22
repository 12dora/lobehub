// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getLiveInfraHealth,
  invalidateInfraHealthMemo,
  resetInfraHealthMemoForTest,
} from './infraHealthMemo';

const probeMocks = vi.hoisted(() => ({
  probeDocumentRenderHealth: vi.fn(async () => null),
  probeSandboxHealth: vi.fn(async () => ({
    activeContainers: 1,
    daemonReachable: true,
    errorCategory: null,
    imagePresent: true,
    lastCheckedAt: new Date('2026-08-18T00:00:00.000Z'),
    maxContainers: 8,
    status: 'healthy' as const,
  })),
}));

vi.mock('./sandboxProbe', () => ({ probeSandboxHealth: probeMocks.probeSandboxHealth }));
vi.mock('./documentRenderProbe', () => ({
  probeDocumentRenderHealth: probeMocks.probeDocumentRenderHealth,
}));

const completeS3 = {
  S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  S3_BUCKET: 'files',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_SECRET_ACCESS_KEY: 'secret',
};

const completeKms = {
  PLATFORM_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('infraHealthMemo', () => {
  const deferredObjectStorage = () => {
    const resolvers: Array<
      (value: {
        errorCategory: 'timeout' | null;
        lastCheckedAt: Date;
        status: 'healthy' | 'unavailable';
      }) => void
    > = [];
    const probe = vi.fn(
      () =>
        new Promise<{
          errorCategory: 'timeout' | null;
          lastCheckedAt: Date;
          status: 'healthy' | 'unavailable';
        }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    return { probe, resolvers };
  };

  beforeEach(() => {
    resetInfraHealthMemoForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInfraHealthMemoForTest();
  });

  it('always runs the full probe set so a partial caller cannot blank the sandbox tile', async () => {
    // The document-render settings card asks only for its own probe…
    const partial = await getLiveInfraHealth({
      keyManagementEnv: completeKms,
      objectStorageEnv: {},
      probeDocumentRender: async () => null,
      probeKeyManagement: async () => ({
        errorCategory: null,
        lastCheckedAt: new Date(),
        status: 'healthy' as const,
      }),
    });
    // …but the memo it fills (shared for 30s with the status page) still carries sandbox.
    expect(partial.sandbox?.status).toBe('healthy');
    expect(probeMocks.probeSandboxHealth).toHaveBeenCalledTimes(1);

    const status = await getLiveInfraHealth({
      keyManagementEnv: completeKms,
      objectStorageEnv: {},
      probeKeyManagement: async () => ({
        errorCategory: null,
        lastCheckedAt: new Date(),
        status: 'healthy' as const,
      }),
    });
    expect(status.sandbox?.status).toBe('healthy');
    expect(probeMocks.probeSandboxHealth).toHaveBeenCalledTimes(1);
  });

  it('probes once within the 30s TTL and coalesces in-flight callers', async () => {
    let resolveStorage:
      | ((value: { errorCategory: null; lastCheckedAt: Date; status: 'healthy' }) => void)
      | undefined;
    const objectStorageProbe = vi.fn(
      () =>
        new Promise<{
          errorCategory: null;
          lastCheckedAt: Date;
          status: 'healthy';
        }>((resolve) => {
          resolveStorage = resolve;
        }),
    );
    const keyManagementProbe = vi.fn(async () => ({
      errorCategory: null,
      lastCheckedAt: new Date(),
      status: 'healthy' as const,
    }));

    const first = getLiveInfraHealth({
      getScopeEpoch: async () => '1',
      keyManagementEnv: completeKms,
      objectStorageEnv: completeS3,
      probeKeyManagement: keyManagementProbe,
      probeObjectStorageHealth: objectStorageProbe,
    });
    const second = getLiveInfraHealth({
      getScopeEpoch: async () => '1',
      keyManagementEnv: completeKms,
      objectStorageEnv: completeS3,
      probeKeyManagement: keyManagementProbe,
      probeObjectStorageHealth: objectStorageProbe,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(objectStorageProbe).toHaveBeenCalledOnce();
    resolveStorage?.({
      errorCategory: null,
      lastCheckedAt: new Date(),
      status: 'healthy',
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    vi.advanceTimersByTime(29_000);
    await getLiveInfraHealth({
      getScopeEpoch: async () => '1',
      keyManagementEnv: completeKms,
      objectStorageEnv: completeS3,
      probeKeyManagement: keyManagementProbe,
      probeObjectStorageHealth: objectStorageProbe,
    });
    expect(objectStorageProbe).toHaveBeenCalledOnce();
  });

  it('coalesces the document-render probe with the 30s single-flight memo', async () => {
    const probeDocumentRender = vi.fn(async () => ({
      configured: true,
      detail: 'Gotenberg',
      errorCategory: null,
      lastCheckedAt: new Date(),
      latencyMs: 18,
      queuePending: 1,
      queueRunning: 0,
      status: 'healthy' as const,
      version: '8.21.0',
    }));
    const params = {
      getScopeEpoch: async () => '1',
      keyManagementEnv: completeKms,
      objectStorageEnv: completeS3,
      probeDocumentRender,
      probeKeyManagement: async () => ({
        errorCategory: null,
        lastCheckedAt: new Date(),
        status: 'healthy' as const,
      }),
      probeObjectStorageHealth: async () => ({
        detail: 'S3 · files',
        errorCategory: null,
        lastCheckedAt: new Date(),
        latencyMs: 24,
        status: 'healthy' as const,
      }),
    };

    const first = await getLiveInfraHealth(params);
    const second = await getLiveInfraHealth(params);
    expect(probeDocumentRender).toHaveBeenCalledOnce();
    expect(first.documentRender).toMatchObject({
      configured: true,
      detail: 'Gotenberg',
      latencyMs: 18,
      version: '8.21.0',
    });
    expect(first.objectStorage).toMatchObject({ detail: 'S3 · files', latencyMs: 24 });
    expect(second.documentRender).toBe(first.documentRender);
    expect(second.objectStorage).toBe(first.objectStorage);
  });

  it('coalesces the sandbox probe with the 30s single-flight memo', async () => {
    const probeSandbox = vi.fn(async () => ({
      activeContainers: 1,
      daemonReachable: true,
      errorCategory: null,
      imagePresent: true,
      lastCheckedAt: new Date(),
      maxContainers: 8,
      status: 'healthy' as const,
    }));
    const params = {
      getScopeEpoch: async () => '1',
      keyManagementEnv: completeKms,
      objectStorageEnv: completeS3,
      probeKeyManagement: async () => ({
        errorCategory: null,
        lastCheckedAt: new Date(),
        status: 'healthy' as const,
      }),
      probeObjectStorageHealth: async () => ({
        errorCategory: null,
        lastCheckedAt: new Date(),
        status: 'healthy' as const,
      }),
      probeSandbox,
    };

    const first = await getLiveInfraHealth(params);
    const second = await getLiveInfraHealth(params);
    expect(probeSandbox).toHaveBeenCalledOnce();
    expect(first.sandbox).toMatchObject({ daemonReachable: true, imagePresent: true });
    expect(second.sandbox).toBe(first.sandbox);
  });

  it('reprobes after TTL expiry or an infra-settings epoch bump', async () => {
    const objectStorageProbe = vi.fn(async () => ({
      errorCategory: null,
      lastCheckedAt: new Date(),
      status: 'healthy' as const,
    }));
    const params = {
      getScopeEpoch: async () => '1',
      keyManagementEnv: completeKms,
      objectStorageEnv: completeS3,
      probeKeyManagement: async () => ({
        errorCategory: null,
        lastCheckedAt: new Date(),
        status: 'healthy' as const,
      }),
      probeObjectStorageHealth: objectStorageProbe,
    };

    await getLiveInfraHealth(params);
    vi.advanceTimersByTime(30_001);
    await getLiveInfraHealth(params);
    expect(objectStorageProbe).toHaveBeenCalledTimes(2);

    await getLiveInfraHealth({ ...params, getScopeEpoch: async () => '2' });
    expect(objectStorageProbe).toHaveBeenCalledTimes(3);

    invalidateInfraHealthMemo();
    await getLiveInfraHealth({ ...params, getScopeEpoch: async () => '2' });
    expect(objectStorageProbe).toHaveBeenCalledTimes(4);
  });

  it('does not join or cache a probe superseded by invalidation', async () => {
    const { probe, resolvers } = deferredObjectStorage();
    const params = {
      getScopeEpoch: async () => '1',
      keyManagementEnv: completeKms,
      objectStorageEnv: completeS3,
      probeKeyManagement: async () => ({
        errorCategory: null,
        lastCheckedAt: new Date(),
        status: 'healthy' as const,
      }),
      probeObjectStorageHealth: probe,
    };

    const first = getLiveInfraHealth(params);
    await Promise.resolve();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();

    invalidateInfraHealthMemo();
    const second = getLiveInfraHealth(params);
    await Promise.resolve();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2);

    const stale = {
      errorCategory: null,
      lastCheckedAt: new Date('2026-08-18T00:00:00.000Z'),
      status: 'healthy' as const,
    };
    const fresh = {
      errorCategory: 'timeout' as const,
      lastCheckedAt: new Date('2026-08-18T00:00:01.000Z'),
      status: 'unavailable' as const,
    };
    resolvers[0]?.(stale);
    await expect(first).resolves.toMatchObject({ objectStorage: stale });

    resolvers[1]?.(fresh);
    await expect(second).resolves.toMatchObject({ objectStorage: fresh });

    await expect(getLiveInfraHealth(params)).resolves.toMatchObject({ objectStorage: fresh });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not join or cache a probe superseded by an epoch bump', async () => {
    const { probe, resolvers } = deferredObjectStorage();
    let epoch = '1';
    const params = {
      getScopeEpoch: async () => epoch,
      keyManagementEnv: completeKms,
      objectStorageEnv: completeS3,
      probeKeyManagement: async () => ({
        errorCategory: null,
        lastCheckedAt: new Date(),
        status: 'healthy' as const,
      }),
      probeObjectStorageHealth: probe,
    };

    const first = getLiveInfraHealth(params);
    await Promise.resolve();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();

    epoch = '2';
    const second = getLiveInfraHealth(params);
    await Promise.resolve();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2);

    const stale = {
      errorCategory: null,
      lastCheckedAt: new Date('2026-08-18T00:00:00.000Z'),
      status: 'healthy' as const,
    };
    const fresh = {
      errorCategory: 'timeout' as const,
      lastCheckedAt: new Date('2026-08-18T00:00:01.000Z'),
      status: 'unavailable' as const,
    };
    resolvers[0]?.(stale);
    await expect(first).resolves.toMatchObject({ objectStorage: stale });
    resolvers[1]?.(fresh);
    await expect(second).resolves.toMatchObject({ objectStorage: fresh });

    await expect(getLiveInfraHealth(params)).resolves.toMatchObject({ objectStorage: fresh });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not call probes when the config is disabled or incomplete', async () => {
    const objectStorageProbe = vi.fn();
    const keyManagementProbe = vi.fn();
    const result = await getLiveInfraHealth({
      getScopeEpoch: async () => '1',
      keyManagementEnv: {},
      objectStorageEnv: {
        S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        S3_BUCKET: 'files',
        S3_REGION: 'us-west-2',
        S3_SECRET_ACCESS_KEY: 'secret',
      },
      probeKeyManagement: keyManagementProbe,
      probeObjectStorageHealth: objectStorageProbe,
    });

    expect(result.objectStorage).toMatchObject({
      errorCategory: 'configuration_incomplete',
      lastCheckedAt: null,
      status: 'degraded',
    });
    expect(result.keyManagement).toMatchObject({
      errorCategory: null,
      lastCheckedAt: null,
      status: 'disabled',
    });
    expect(objectStorageProbe).not.toHaveBeenCalled();
    expect(keyManagementProbe).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import type { EnterpriseJobBacklogMetricSnapshot } from '@lobechat/observability-otel/modules/enterprise-platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import type { EnterpriseObservabilityEvent } from '../../observability';
import {
  NOOP_ENTERPRISE_STRUCTURED_LOGGER,
  setEnterprisePlatformObserverForTest,
  setEnterpriseStructuredLoggerForTest,
} from '../../observability';
import {
  ensureOperationalMetricsRuntimeStarted,
  OPERATIONAL_METRICS_COLLECTION_INTERVAL_MS,
  resetOperationalMetricsRuntimeForTest,
  shouldStartOperationalMetricsRuntime,
  stopOperationalMetricsRuntime,
} from './operationalMetricsRuntime';

const db = {} as LobeChatDatabase;
const productionEnv = (identity = false): Record<string, string | undefined> => ({
  DATABASE_URL: 'postgresql://database.invalid/lobehub',
  ENABLE_DATABASE_OIDC: identity ? '1' : undefined,
  ENABLE_PLATFORM_ADMIN: '1',
  ENABLE_TELEMETRY: '1',
  NEXT_RUNTIME: 'nodejs',
  NODE_ENV: 'production',
});
const backlogSnapshot = (collectedAtMs = 10_000) => ({
  entries: [
    { count: 2, oldestAgeSeconds: 7, state: 'pending' as const },
    { count: 1, oldestAgeSeconds: 3, state: 'reserved_expired' as const },
    { count: 0, oldestAgeSeconds: 0, state: 'running_lease_expired' as const },
  ],
  snapshotAt: new Date(collectedAtMs),
});
const metricSink = () => ({
  activate: vi.fn(),
  setJobBacklog: vi.fn(),
  setRevisionLag: vi.fn(),
});
const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
};

let observations: EnterpriseObservabilityEvent[];

beforeEach(() => {
  resetOperationalMetricsRuntimeForTest();
  observations = [];
  setEnterprisePlatformObserverForTest({ record: (event) => observations.push(event) });
  setEnterpriseStructuredLoggerForTest(NOOP_ENTERPRISE_STRUCTURED_LOGGER);
});

afterEach(() => {
  resetOperationalMetricsRuntimeForTest();
  setEnterprisePlatformObserverForTest(null);
  setEnterpriseStructuredLoggerForTest(null);
  vi.restoreAllMocks();
});

describe('operational metrics runtime', () => {
  it('starts only for persistent production Node with DB, enterprise, and telemetry enabled', () => {
    expect(shouldStartOperationalMetricsRuntime(productionEnv())).toBe(true);
    for (const unsupported of [
      { NODE_ENV: 'development' },
      { NEXT_RUNTIME: 'edge' },
      { DATABASE_URL: undefined },
      { ENABLE_PLATFORM_ADMIN: '0' },
      { ENABLE_TELEMETRY: '0' },
      { NEXT_PHASE: 'phase-production-build' },
      { npm_lifecycle_event: 'build' },
      { VERCEL: '1' },
      { VERCEL_ENV: 'production' },
      { AWS_LAMBDA_FUNCTION_NAME: 'handler' },
      { AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x' },
    ]) {
      expect(shouldStartOperationalMetricsRuntime({ ...productionEnv(), ...unsupported })).toBe(
        false,
      );
    }
  });

  it('gates unsupported runtimes before database access or timer creation', async () => {
    const getDatabase = vi.fn();
    const schedule = vi.fn();

    await expect(
      ensureOperationalMetricsRuntimeStarted({
        env: { ...productionEnv(), ENABLE_TELEMETRY: '0' },
        getDatabase,
        schedule,
      }),
    ).resolves.toBe(false);

    expect(getDatabase).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('collects immediately and creates one unref 60 second timer across concurrent starts', async () => {
    const sink = metricSink();
    const getBacklogSnapshot = vi.fn().mockResolvedValue(backlogSnapshot());
    const getDatabase = vi.fn().mockResolvedValue(db);
    const unref = vi.fn();
    const schedule = vi.fn(() => ({ unref }));
    const options = {
      createJobModel: () => ({ getBacklogSnapshot }),
      env: productionEnv(),
      getDatabase,
      metricSink: sink,
      schedule,
    };

    await expect(
      Promise.all([
        ensureOperationalMetricsRuntimeStarted(options),
        ensureOperationalMetricsRuntimeStarted(options),
      ]),
    ).resolves.toEqual([true, true]);

    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(getBacklogSnapshot).toHaveBeenCalledTimes(1);
    expect(sink.activate).toHaveBeenCalledWith(['job_backlog']);
    expect(sink.setJobBacklog).toHaveBeenCalledWith({
      collectedAtMs: 10_000,
      entries: backlogSnapshot().entries,
    });
    expect(schedule).toHaveBeenCalledWith(
      expect.any(Function),
      OPERATIONAL_METRICS_COLLECTION_INTERVAL_MS,
    );
    expect(unref).toHaveBeenCalledTimes(1);
    expect(observations).toContainEqual(
      expect.objectContaining({
        collector: 'job_backlog',
        outcome: 'success',
        type: 'operational_collection',
      }),
    );
  });

  it('collects real identity target and registry aggregates only when OIDC is enabled', async () => {
    const sink = metricSink();
    const targetRevision = 'a'.repeat(64);
    const loadIdentityTarget = vi.fn().mockResolvedValue({
      environmentShadowed: [],
      identityRevision: targetRevision,
      providers: [],
    });
    const getIdentityRevisionLagSnapshot = vi.fn().mockResolvedValue({
      freshInstances: 3,
      laggingInstances: [
        { count: 1, reason: 'degraded' },
        { count: 1, reason: 'diverged' },
      ],
      snapshotAt: new Date(12_000),
    });

    await ensureOperationalMetricsRuntimeStarted({
      createInstanceRepository: () => ({ getIdentityRevisionLagSnapshot }),
      createJobModel: () => ({ getBacklogSnapshot: vi.fn().mockResolvedValue(backlogSnapshot()) }),
      env: productionEnv(true),
      getDatabase: async () => db,
      loadIdentityTarget,
      metricSink: sink,
      schedule: () => ({ unref: vi.fn() }),
    });

    expect(sink.activate).toHaveBeenCalledWith(['job_backlog', 'revision_lag']);
    expect(loadIdentityTarget).toHaveBeenCalledWith(db, productionEnv(true));
    expect(getIdentityRevisionLagSnapshot).toHaveBeenCalledWith(targetRevision);
    expect(sink.setRevisionLag).toHaveBeenCalledWith({
      collectedAtMs: 12_000,
      domain: 'identity',
      freshInstances: 3,
      laggingInstances: [
        { count: 1, reason: 'degraded' },
        { count: 1, reason: 'diverged' },
      ],
    });
  });

  it.each([
    ['reset', resetOperationalMetricsRuntimeForTest],
    ['stop', stopOperationalMetricsRuntime],
  ])(
    'retires an initial in-flight collection on %s without publishing or scheduling',
    async (_name, retire) => {
      const sink = metricSink();
      const initial = deferred<ReturnType<typeof backlogSnapshot>>();
      const getBacklogSnapshot = vi.fn().mockReturnValue(initial.promise);
      const schedule = vi.fn();
      const start = ensureOperationalMetricsRuntimeStarted({
        createJobModel: () => ({ getBacklogSnapshot }),
        env: productionEnv(),
        getDatabase: async () => db,
        metricSink: sink,
        schedule,
      });
      await vi.waitFor(() => expect(getBacklogSnapshot).toHaveBeenCalledTimes(1));

      retire();
      initial.resolve(backlogSnapshot());

      await expect(start).resolves.toBe(false);
      expect(sink.setJobBacklog).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
      expect(observations).toHaveLength(0);
    },
  );

  it('keeps a restarted generation independent from a retired in-flight tick', async () => {
    const oldSink = metricSink();
    const oldTickSnapshot = deferred<ReturnType<typeof backlogSnapshot>>();
    const oldGetBacklogSnapshot = vi
      .fn()
      .mockResolvedValueOnce(backlogSnapshot())
      .mockReturnValueOnce(oldTickSnapshot.promise);
    const oldClear = vi.fn();
    let oldTick: (() => void) | undefined;
    await ensureOperationalMetricsRuntimeStarted({
      createJobModel: () => ({ getBacklogSnapshot: oldGetBacklogSnapshot }),
      env: productionEnv(),
      getDatabase: async () => db,
      metricSink: oldSink,
      schedule: (callback) => {
        oldTick = callback;
        return { clear: oldClear, unref: vi.fn() };
      },
    });

    oldTick?.();
    await vi.waitFor(() => expect(oldGetBacklogSnapshot).toHaveBeenCalledTimes(2));
    resetOperationalMetricsRuntimeForTest();

    const newSink = metricSink();
    const newGetBacklogSnapshot = vi
      .fn()
      .mockResolvedValueOnce(backlogSnapshot(30_000))
      .mockResolvedValueOnce(backlogSnapshot(40_000));
    let newTick: (() => void) | undefined;
    await expect(
      ensureOperationalMetricsRuntimeStarted({
        createJobModel: () => ({ getBacklogSnapshot: newGetBacklogSnapshot }),
        env: productionEnv(),
        getDatabase: async () => db,
        metricSink: newSink,
        schedule: (callback) => {
          newTick = callback;
          return { unref: vi.fn() };
        },
      }),
    ).resolves.toBe(true);

    oldTickSnapshot.resolve(backlogSnapshot(20_000));
    await oldTickSnapshot.promise;
    await Promise.resolve();
    expect(oldClear).toHaveBeenCalledTimes(1);
    expect(oldSink.setJobBacklog).toHaveBeenCalledTimes(1);
    expect(newSink.setJobBacklog).toHaveBeenLastCalledWith(
      expect.objectContaining({ collectedAtMs: 30_000 }),
    );

    oldTick?.();
    expect(oldGetBacklogSnapshot).toHaveBeenCalledTimes(2);
    newTick?.();
    await vi.waitFor(() => expect(newGetBacklogSnapshot).toHaveBeenCalledTimes(2));
    expect(newSink.setJobBacklog).toHaveBeenLastCalledWith(
      expect.objectContaining({ collectedAtMs: 40_000 }),
    );
    await vi.waitFor(() =>
      expect(
        observations.filter(
          (event) => event.type === 'operational_collection' && event.outcome === 'success',
        ),
      ).toHaveLength(3),
    );
  });

  it('stops an active generation idempotently', async () => {
    const sink = metricSink();
    const clear = vi.fn();
    const getBacklogSnapshot = vi.fn().mockResolvedValue(backlogSnapshot());
    let tick: (() => void) | undefined;
    await ensureOperationalMetricsRuntimeStarted({
      createJobModel: () => ({ getBacklogSnapshot }),
      env: productionEnv(),
      getDatabase: async () => db,
      metricSink: sink,
      schedule: (callback) => {
        tick = callback;
        return { clear, unref: vi.fn() };
      },
    });

    stopOperationalMetricsRuntime();
    stopOperationalMetricsRuntime();
    tick?.();

    expect(clear).toHaveBeenCalledTimes(1);
    expect(sink.activate).toHaveBeenNthCalledWith(1, ['job_backlog']);
    expect(sink.activate).toHaveBeenNthCalledWith(2, []);
    expect(sink.activate).toHaveBeenCalledTimes(2);
    expect(getBacklogSnapshot).toHaveBeenCalledTimes(1);
  });

  it('skips overlapping ticks and resumes collection after the in-flight tick settles', async () => {
    const sink = metricSink();
    let resolveSecond: ((value: ReturnType<typeof backlogSnapshot>) => void) | undefined;
    const second = new Promise<ReturnType<typeof backlogSnapshot>>((resolve) => {
      resolveSecond = resolve;
    });
    const getBacklogSnapshot = vi
      .fn()
      .mockResolvedValueOnce(backlogSnapshot())
      .mockReturnValueOnce(second)
      .mockResolvedValueOnce(backlogSnapshot(30_000));
    let tick: (() => void) | undefined;
    await ensureOperationalMetricsRuntimeStarted({
      createJobModel: () => ({ getBacklogSnapshot }),
      env: productionEnv(),
      getDatabase: async () => db,
      metricSink: sink,
      schedule: (callback) => {
        tick = callback;
        return { unref: vi.fn() };
      },
    });

    tick?.();
    tick?.();
    expect(getBacklogSnapshot).toHaveBeenCalledTimes(2);
    resolveSecond?.(backlogSnapshot(20_000));
    await vi.waitFor(() => expect(sink.setJobBacklog).toHaveBeenCalledTimes(2));

    tick?.();
    await vi.waitFor(() => expect(getBacklogSnapshot).toHaveBeenCalledTimes(3));
  });

  it('preserves the previous snapshot and reports only a stable error class on failure', async () => {
    const sink = metricSink();
    let latest: EnterpriseJobBacklogMetricSnapshot | undefined;
    sink.setJobBacklog.mockImplementation((snapshot) => {
      latest = snapshot;
    });
    const getBacklogSnapshot = vi
      .fn()
      .mockResolvedValueOnce(backlogSnapshot())
      .mockRejectedValueOnce(new TypeError('raw-sensitive-database-detail'));
    let tick: (() => void) | undefined;
    const logFailure = vi.fn();
    await ensureOperationalMetricsRuntimeStarted({
      createJobModel: () => ({ getBacklogSnapshot }),
      env: productionEnv(),
      getDatabase: async () => db,
      logFailure,
      metricSink: sink,
      schedule: (callback) => {
        tick = callback;
        return { unref: vi.fn() };
      },
    });
    const initial = latest;

    tick?.();
    await vi.waitFor(() =>
      expect(logFailure).toHaveBeenCalledWith({
        collector: 'job_backlog',
        errorClass: 'UnexpectedError',
      }),
    );

    expect(latest).toBe(initial);
    expect(sink.setJobBacklog).toHaveBeenCalledTimes(1);
    expect(observations).toContainEqual(
      expect.objectContaining({
        collector: 'job_backlog',
        errorClass: 'UnexpectedError',
        outcome: 'failure',
      }),
    );
    expect(JSON.stringify({ logCalls: logFailure.mock.calls, observations })).not.toContain(
      'raw-sensitive',
    );
  });

  it('schedules bounded startup retry when the database cannot initialize (SAO-007)', async () => {
    const sink = metricSink();
    const logFailure = vi.fn();
    const schedule = vi.fn((_callback: () => void, _intervalMs: number) => ({
      clear: vi.fn(),
      unref: vi.fn(),
    }));
    const scheduleRetry = vi.fn((_callback: () => void, _delayMs: number) => ({
      clear: vi.fn(),
      unref: vi.fn(),
    }));

    await expect(
      ensureOperationalMetricsRuntimeStarted({
        env: productionEnv(),
        getDatabase: vi.fn().mockRejectedValue(new Error('raw-connection-detail')),
        logFailure,
        metricSink: sink,
        schedule,
        scheduleRetry,
      }),
    ).resolves.toBe(false);

    expect(sink.activate).toHaveBeenCalledWith(['job_backlog']);
    expect(sink.setJobBacklog).not.toHaveBeenCalled();
    // Recurring interval is NOT installed until acquisition succeeds.
    expect(schedule).not.toHaveBeenCalled();
    // One-shot retry IS armed so a later successful acquisition can start collection.
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
    expect(scheduleRetry.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(2_500);
    expect(logFailure).toHaveBeenCalledWith({
      collector: 'job_backlog',
      errorClass: 'UnexpectedError',
    });
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('raw-connection-detail');
  });

  it('activates recurring collection after a rejected first acquisition then success (SAO-007)', async () => {
    const sink = metricSink();
    const getDatabase = vi
      .fn()
      .mockRejectedValueOnce(new Error('raw-connection-detail'))
      .mockResolvedValueOnce(db);
    const schedule = vi.fn((_callback: () => void, _intervalMs: number) => ({
      clear: vi.fn(),
      unref: vi.fn(),
    }));
    let retryCallback: (() => void) | undefined;
    const scheduleRetry = vi.fn((callback: () => void, _delayMs: number) => {
      retryCallback = callback;
      return { clear: vi.fn(), unref: vi.fn() };
    });
    const createJobModel = vi.fn(() => ({
      getBacklogSnapshot: vi.fn(async () => backlogSnapshot()),
    }));

    await expect(
      ensureOperationalMetricsRuntimeStarted({
        createJobModel,
        env: productionEnv(),
        getDatabase,
        metricSink: sink,
        schedule,
        scheduleRetry,
      }),
    ).resolves.toBe(false);

    expect(schedule).not.toHaveBeenCalled();
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
    expect(retryCallback).toBeTypeOf('function');

    await expect(
      // Fire the armed retry (simulates backoff timer).
      (async () => {
        retryCallback?.();
        // Allow the re-entrant start promise to settle.
        await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
      })(),
    ).resolves.toBeUndefined();

    expect(getDatabase).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[1]).toBe(OPERATIONAL_METRICS_COLLECTION_INTERVAL_MS);
    expect(sink.setJobBacklog).toHaveBeenCalledTimes(1);
  });
});

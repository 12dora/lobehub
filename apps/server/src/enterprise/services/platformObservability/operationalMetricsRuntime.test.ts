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

  it('activates readiness but starts no timer when the database cannot initialize', async () => {
    const sink = metricSink();
    const logFailure = vi.fn();
    const schedule = vi.fn();

    await expect(
      ensureOperationalMetricsRuntimeStarted({
        env: productionEnv(),
        getDatabase: vi.fn().mockRejectedValue(new Error('raw-connection-detail')),
        logFailure,
        metricSink: sink,
        schedule,
      }),
    ).resolves.toBe(false);

    expect(sink.activate).toHaveBeenCalledWith(['job_backlog']);
    expect(sink.setJobBacklog).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(logFailure).toHaveBeenCalledWith({
      collector: 'job_backlog',
      errorClass: 'UnexpectedError',
    });
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('raw-connection-detail');
  });
});

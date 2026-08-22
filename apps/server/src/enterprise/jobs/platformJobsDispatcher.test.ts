// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformJobItem } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { calculatePersistentWorkerRetryDelay } from './persistentWorkerScheduler';
import {
  ensurePlatformJobsDispatcherStarted,
  PLATFORM_JOB_DISPATCH_SPECS,
  resetPlatformJobsDispatcherForTest,
  resolveEnabledPlatformJobTypes,
  runPlatformJobsDispatchTick,
} from './platformJobsDispatcher';

const productionEnv = {
  DATABASE_URL: 'postgres://localhost/test',
  NODE_ENV: 'production',
} satisfies Partial<NodeJS.ProcessEnv>;

const spec = (workerName: string) => {
  const found = PLATFORM_JOB_DISPATCH_SPECS.find((item) => item.workerName === workerName);
  if (!found) throw new Error(`missing spec ${workerName}`);
  return found;
};

const job = (type: string, id: string): PlatformJobItem =>
  ({
    attempt: 1,
    id,
    type,
  }) as PlatformJobItem;

afterEach(() => {
  resetPlatformJobsDispatcherForTest();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveEnabledPlatformJobTypes', () => {
  it('never includes a type whose module is disabled', () => {
    const enabled = resolveEnabledPlatformJobTypes((id) => id !== 'audit', {
      ...productionEnv,
      PLATFORM_KEY_PROVIDER: 'env',
    });
    expect(enabled.map((item) => item.workerName).sort()).toEqual([
      'agentRollout',
      'connectorRuntimeAudit',
      'connectorSecretCleanup',
      'documentRender',
      'documentRenderGc',
    ]);
    expect(enabled.some((item) => item.jobType.startsWith('platform.audit.'))).toBe(false);
  });

  it('includes secretRewrap only when the key provider is Vault', () => {
    const off = resolveEnabledPlatformJobTypes(() => false, {
      ...productionEnv,
      PLATFORM_KEY_PROVIDER: 'env',
    });
    expect(off.map((item) => item.workerName)).toEqual(['documentRender', 'documentRenderGc']);

    const on = resolveEnabledPlatformJobTypes(() => false, {
      ...productionEnv,
      PLATFORM_KEY_PROVIDER: 'vault',
    });
    expect(on.map((item) => item.workerName)).toEqual([
      'secretRewrap',
      'documentRender',
      'documentRenderGc',
    ]);
  });
});

describe('runPlatformJobsDispatchTick', () => {
  it('claims a mixed-type first wave at cap 1 and never asks for a disabled type', async () => {
    const claimedTypes: string[][] = [];
    const claimedCaps: Array<Record<string, number>> = [];
    const handled: string[] = [];
    const enabled = [spec('auditExport'), spec('agentRollout')];
    let calls = 0;
    const jobs = {
      claimBatch: vi.fn(
        async (params: { limitByType?: Record<string, number>; types: readonly string[] }) => {
          claimedTypes.push([...params.types]);
          claimedCaps.push({ ...params.limitByType });
          calls += 1;
          if (calls === 1) return [job('platform.audit.export.v1', 'job-export')];
          return [];
        },
      ),
    };

    const result = await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => false,
      db: {} as LobeChatDatabase,
      enabledTypes: enabled,
      handleClaimed: async ({ job: claimed }) => {
        handled.push(claimed.type);
      },
      jobs,
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });

    expect(claimedTypes[0]).toEqual(['platform.audit.export.v1', 'platform.agent.rollout.v1']);
    expect(claimedTypes[0]).not.toContain('platform.audit.retention.v1');
    expect(claimedCaps[0]).toEqual({
      'platform.agent.rollout.v1': 1,
      'platform.audit.export.v1': 1,
    });
    expect(handled).toEqual(['platform.audit.export.v1']);
    expect(result).toEqual({ didWork: true });
  });

  it('drops a type from the claim set when its readiness gate fails', async () => {
    const jobs = {
      claimBatch: vi.fn(async () => []),
    };
    await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => false,
      db: {} as LobeChatDatabase,
      enabledTypes: [spec('secretRewrap'), spec('agentRollout')],
      isTypeRunnable: async (item) => item.workerName !== 'secretRewrap',
      jobs,
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });
    expect(jobs.claimBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ['platform.agent.rollout.v1'],
      }),
    );
  });

  it('excludes only the type whose readiness probe throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let waves = 0;
    const jobs = {
      claimBatch: vi.fn(async () => {
        waves += 1;
        return waves === 1 ? [job('platform.audit.export.v1', 'job-export')] : [];
      }),
    };
    await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => false,
      db: {} as LobeChatDatabase,
      enabledTypes: [spec('secretRewrap'), spec('auditExport')],
      handleClaimed: async () => undefined,
      isTypeRunnable: async (item) => {
        if (item.workerName === 'secretRewrap') throw new TypeError('vault down');
        return true;
      },
      jobs,
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });
    expect(jobs.claimBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ['platform.audit.export.v1'],
      }),
    );
    expect(error).toHaveBeenCalledWith('[platformJobsDispatcher] readiness failed', {
      errorClass: 'TypeError',
      type: 'platform.secret.rewrap.v1',
    });
  });

  it('isolates a throwing lane so the other type still runs', async () => {
    const handled: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let wave = 0;
    const result = await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => false,
      db: {} as LobeChatDatabase,
      enabledTypes: [spec('auditExport'), spec('agentRollout')],
      handleClaimed: async ({ job: claimed }) => {
        handled.push(claimed.type);
        if (claimed.type === 'platform.audit.export.v1') throw new TypeError('boom');
      },
      jobs: {
        claimBatch: async () => {
          wave += 1;
          if (wave !== 1) return [];
          return [
            job('platform.audit.export.v1', 'job-export'),
            job('platform.agent.rollout.v1', 'job-rollout'),
          ];
        },
      },
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });

    expect(handled.sort()).toEqual(['platform.agent.rollout.v1', 'platform.audit.export.v1']);
    expect(result).toEqual({ didWork: true });
    expect(error).toHaveBeenCalledWith('[platformJobsDispatcher] handler failed', {
      errorClass: 'TypeError',
      type: 'platform.audit.export.v1',
    });
  });

  it('backs off a throwing type on the next tick while other lanes still run', async () => {
    const handled: string[][] = [];
    const firstWaveTypes: string[][] = [];
    const run = async () => {
      const seen: string[] = [];
      let firstWave = true;
      await runPlatformJobsDispatchTick({
        cleanupExpiredReservation: async () => false,
        db: {} as LobeChatDatabase,
        enabledTypes: [spec('agentRollout'), spec('auditExport')],
        handleClaimed: async ({ job: claimed }) => {
          seen.push(claimed.type);
          if (claimed.type === 'platform.agent.rollout.v1') throw new TypeError('boom');
        },
        jobs: {
          claimBatch: async (params) => {
            if (firstWave) {
              firstWave = false;
              firstWaveTypes.push([...params.types]);
              return params.types.map((type) => job(type, `${type}:tick`));
            }
            return [];
          },
        },
        onAfterDispatch: async () => undefined,
        workerId: 'dispatcher-test',
      });
      handled.push(seen);
    };

    await run();
    await run();

    expect(handled[0]?.sort()).toEqual(['platform.agent.rollout.v1', 'platform.audit.export.v1']);
    expect(firstWaveTypes[1]).toEqual(['platform.audit.export.v1']);
    expect(handled[1]).toEqual(['platform.audit.export.v1']);
  });

  it('logs a rejected follow-up claim and continues the tick', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handled: string[] = [];
    let wave = 0;
    await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => false,
      db: {} as LobeChatDatabase,
      enabledTypes: [spec('auditExport'), spec('agentRollout')],
      handleClaimed: async ({ job: claimed }) => {
        handled.push(claimed.type);
      },
      jobs: {
        claimBatch: async (params) => {
          wave += 1;
          if (wave === 1) {
            return [
              job('platform.audit.export.v1', 'job-export'),
              job('platform.agent.rollout.v1', 'job-rollout'),
            ];
          }
          if (params.types.includes('platform.audit.export.v1')) {
            throw new TypeError('claim unavailable');
          }
          return [];
        },
      },
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });
    expect(handled.sort()).toEqual(['platform.agent.rollout.v1', 'platform.audit.export.v1']);
    expect(error).toHaveBeenCalledWith('[platformJobsDispatcher] claim failed', {
      errorClass: 'TypeError',
      type: 'platform.audit.export.v1',
    });
  });

  it('omits runtime-audit when reservation cleanup throws and still claims other types', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let waves = 0;
    const jobs = {
      claimBatch: vi.fn(async () => {
        waves += 1;
        return waves === 1 ? [job('platform.audit.export.v1', 'job-export')] : [];
      }),
    };
    await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => {
        throw new TypeError('delete failed');
      },
      db: {} as LobeChatDatabase,
      enabledTypes: [spec('connectorRuntimeAudit'), spec('auditExport')],
      handleClaimed: async () => undefined,
      jobs,
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });
    expect(jobs.claimBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ['platform.audit.export.v1'],
      }),
    );
    expect(error).toHaveBeenCalledWith('[platformJobsDispatcher] readiness failed', {
      errorClass: 'TypeError',
      type: 'connector.runtime.shared-call.v1',
    });
  });

  it('production cleanup wrapper stops the lane after { stop: true }', async () => {
    const cleanupMod = await import('../services/connectorCatalog/secretCleanupWorker');
    vi.spyOn(cleanupMod, 'handleClaimedConnectorSecretCleanupJob').mockResolvedValue({
      stop: true,
    });
    const queue = [
      job('connector.secret.cleanup.v1', 'cleanup-1'),
      job('connector.secret.cleanup.v1', 'cleanup-2'),
    ];
    const claimBatch = vi.fn(async () => {
      const next = queue.shift();
      return next ? [next] : [];
    });
    await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => false,
      db: {} as LobeChatDatabase,
      enabledTypes: [spec('connectorSecretCleanup')],
      isTypeRunnable: async () => true,
      jobs: { claimBatch },
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });
    expect(cleanupMod.handleClaimedConnectorSecretCleanupJob).toHaveBeenCalledOnce();
    expect(claimBatch).toHaveBeenCalledTimes(1);
    expect(queue.map((item) => item.id)).toEqual(['cleanup-2']);
  });

  it('stops a lane without claiming the next job when the handler says stop', async () => {
    const handled: string[] = [];
    const queue = [
      job('connector.secret.cleanup.v1', 'cleanup-1'),
      job('connector.secret.cleanup.v1', 'cleanup-2'),
    ];
    const claimBatch = vi.fn(async () => {
      const next = queue.shift();
      return next ? [next] : [];
    });
    await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => false,
      db: {} as LobeChatDatabase,
      enabledTypes: [spec('connectorSecretCleanup')],
      handleClaimed: async ({ job: claimed }) => {
        handled.push(claimed.id);
        return { stop: true };
      },
      isTypeRunnable: async () => true,
      jobs: { claimBatch },
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });
    expect(handled).toEqual(['cleanup-1']);
    expect(queue.map((item) => item.id)).toEqual(['cleanup-2']);
    expect(claimBatch).toHaveBeenCalledTimes(1);
  });

  it('processes a lane one claim at a time and never leases a sibling while handling', async () => {
    const queue = [
      job('platform.audit.export.v1', 'job-a'),
      job('platform.audit.export.v1', 'job-b'),
      job('platform.audit.export.v1', 'job-c'),
    ];
    const handled: string[] = [];
    const runningWhileHandle: number[] = [];
    const leased = new Set<string>();
    const claimBatch = vi.fn(async () => {
      const next = queue.shift();
      if (!next) return [];
      leased.add(next.id);
      return [next];
    });
    await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => false,
      db: {} as LobeChatDatabase,
      enabledTypes: [{ ...spec('auditExport'), batchLimit: 5 }],
      handleClaimed: async ({ job: claimed }) => {
        runningWhileHandle.push(leased.size);
        expect(leased.has(claimed.id)).toBe(true);
        handled.push(claimed.id);
        leased.delete(claimed.id);
      },
      jobs: { claimBatch },
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });
    expect(handled).toEqual(['job-a', 'job-b', 'job-c']);
    expect(runningWhileHandle).toEqual([1, 1, 1]);
    expect(claimBatch).toHaveBeenCalledTimes(4);
  });

  it('treats reserved-row cleanup as work even when the claim is empty', async () => {
    const result = await runPlatformJobsDispatchTick({
      cleanupExpiredReservation: async () => true,
      db: {} as LobeChatDatabase,
      enabledTypes: [spec('connectorRuntimeAudit')],
      handleClaimed: async () => {
        throw new Error('should not run');
      },
      jobs: { claimBatch: async () => [] },
      onAfterDispatch: async () => undefined,
      workerId: 'dispatcher-test',
    });
    expect(result).toEqual({ didWork: true });
  });

  it('reports no work when the enable-set is empty', async () => {
    await expect(
      runPlatformJobsDispatchTick({
        db: {} as LobeChatDatabase,
        enabledTypes: [],
        jobs: { claimBatch: async () => [job('platform.audit.export.v1', 'x')] },
        workerId: 'dispatcher-test',
      }),
    ).resolves.toEqual({ didWork: false });
  });
});

describe('retryAt backoff', () => {
  // Non-midpoint jitter so delays are not exact tick multiples (0.5 → 0 jitter).
  const RANDOM = 0.9;
  const delayAfter = (intervalMs: number, consecutive: number) =>
    calculatePersistentWorkerRetryDelay(intervalMs, consecutive, 60_000, () => RANDOM);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM);
  });

  const firstTickAtOrAfter = (from: number, retryAt: number, tickMs: number) =>
    from + Math.ceil((retryAt - from) / tickMs) * tickMs;

  it('retries consecutive handler failures at the first tick at or after retryAt', async () => {
    const rollout = spec('agentRollout');
    const tickMs = rollout.intervalMs;
    const waves: number[] = [];
    const tick = async () => {
      let firstWave = true;
      return runPlatformJobsDispatchTick({
        cleanupExpiredReservation: async () => false,
        db: {} as LobeChatDatabase,
        enabledTypes: [rollout],
        handleClaimed: async () => {
          throw new TypeError('boom');
        },
        jobs: {
          claimBatch: async (params) => {
            if (!firstWave) return [];
            firstWave = false;
            waves.push(Date.now());
            return params.types.map((type) => job(type, `${type}:${Date.now()}`));
          },
        },
        now: () => Date.now(),
        onAfterDispatch: async () => undefined,
        workerId: 'dispatcher-test',
      });
    };

    const origin = Date.now();
    await expect(tick()).resolves.toEqual({ didWork: true });
    expect(waves).toEqual([origin]);

    // In-backoff ticks still report work so shared idle backoff cannot stretch retryAt.
    await expect(tick()).resolves.toEqual({ didWork: true });
    expect(waves).toHaveLength(1);

    for (const consecutive of [1, 2, 3]) {
      const failedAt = waves.at(-1)!;
      const retryAt = failedAt + delayAfter(rollout.intervalMs, consecutive);
      const expected = firstTickAtOrAfter(failedAt, retryAt, tickMs);
      while (Date.now() + tickMs < retryAt) {
        vi.advanceTimersByTime(tickMs);
        await tick();
        expect(waves).toHaveLength(consecutive);
      }
      vi.advanceTimersByTime(expected - Date.now());
      await tick();
      expect(waves).toHaveLength(consecutive + 1);
      expect(waves.at(-1)).toBe(expected);
      expect(waves.at(-1)!).toBeGreaterThanOrEqual(retryAt);
    }
  });

  it('anchors retryAt at the throw, not at tick start', async () => {
    const rollout = spec('agentRollout');
    const waves: number[] = [];
    const tick = async () => {
      let firstWave = true;
      return runPlatformJobsDispatchTick({
        cleanupExpiredReservation: async () => false,
        db: {} as LobeChatDatabase,
        enabledTypes: [rollout],
        handleClaimed: async () => {
          vi.advanceTimersByTime(rollout.intervalMs * 3);
          throw new TypeError('boom');
        },
        jobs: {
          claimBatch: async (params) => {
            if (!firstWave) return [];
            firstWave = false;
            waves.push(Date.now());
            return params.types.map((type) => job(type, `${type}:${Date.now()}`));
          },
        },
        now: () => Date.now(),
        onAfterDispatch: async () => undefined,
        workerId: 'dispatcher-test',
      });
    };

    await tick();
    expect(waves).toHaveLength(1);
    const throwAt = Date.now();
    const retryAt = throwAt + delayAfter(rollout.intervalMs, 1);
    expect(throwAt).toBeGreaterThan(waves[0]! + rollout.intervalMs);

    await tick();
    expect(waves).toHaveLength(1);

    vi.advanceTimersByTime(retryAt - Date.now() - 1);
    await tick();
    expect(waves).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await tick();
    expect(waves).toHaveLength(2);
    expect(waves[1]).toBeGreaterThanOrEqual(retryAt);
  });

  it('backs off a throwing Vault readiness probe and retries only after retryAt', async () => {
    const probes: number[] = [];
    const tick = async () => {
      await runPlatformJobsDispatchTick({
        cleanupExpiredReservation: async () => false,
        db: {} as LobeChatDatabase,
        enabledTypes: [spec('secretRewrap'), spec('auditExport')],
        handleClaimed: async () => undefined,
        isTypeRunnable: async (item) => {
          if (item.workerName === 'secretRewrap') {
            probes.push(Date.now());
            throw new TypeError('vault down');
          }
          return true;
        },
        jobs: { claimBatch: async () => [] },
        now: () => Date.now(),
        onAfterDispatch: async () => undefined,
        workerId: 'dispatcher-test',
      });
    };

    const origin = Date.now();
    const retryAt = origin + delayAfter(spec('secretRewrap').intervalMs, 1);
    await tick();
    expect(probes).toEqual([origin]);
    await tick();
    expect(probes).toEqual([origin]);
    vi.advanceTimersByTime(retryAt - Date.now() - 1);
    await tick();
    expect(probes).toEqual([origin]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(probes).toHaveLength(2);
    expect(probes[1]).toBeGreaterThanOrEqual(retryAt);
  });

  it('backs off a throwing reservation cleanup without blocking other lanes', async () => {
    const cleanups: number[] = [];
    const exportWaves: string[][] = [];
    const tick = async () => {
      let firstWave = true;
      await runPlatformJobsDispatchTick({
        cleanupExpiredReservation: async () => {
          cleanups.push(Date.now());
          throw new TypeError('delete failed');
        },
        db: {} as LobeChatDatabase,
        enabledTypes: [spec('connectorRuntimeAudit'), spec('auditExport')],
        handleClaimed: async () => undefined,
        jobs: {
          claimBatch: async (params) => {
            if (!firstWave) return [];
            firstWave = false;
            exportWaves.push([...params.types]);
            return [];
          },
        },
        now: () => Date.now(),
        onAfterDispatch: async () => undefined,
        workerId: 'dispatcher-test',
      });
    };

    const origin = Date.now();
    const retryAt = origin + delayAfter(spec('connectorRuntimeAudit').intervalMs, 1);
    await tick();
    expect(cleanups).toEqual([origin]);
    expect(exportWaves[0]).toEqual(['platform.audit.export.v1']);
    await tick();
    expect(cleanups).toEqual([origin]);
    expect(exportWaves[1]).toEqual(['platform.audit.export.v1']);
    vi.advanceTimersByTime(retryAt - Date.now() - 1);
    await tick();
    expect(cleanups).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await tick();
    expect(cleanups).toHaveLength(2);
    expect(cleanups[1]).toBeGreaterThanOrEqual(retryAt);
    expect(exportWaves.at(-1)).toEqual(['platform.audit.export.v1']);
  });

  it('backs off each type from a rejected first-wave claim using its own delay', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exportSpec = spec('auditExport');
    const auditSpec = spec('connectorRuntimeAudit');
    const waves: string[][] = [];
    const tick = async () => {
      let firstWave = true;
      return runPlatformJobsDispatchTick({
        cleanupExpiredReservation: async () => false,
        db: {} as LobeChatDatabase,
        enabledTypes: [exportSpec, auditSpec],
        handleClaimed: async () => undefined,
        jobs: {
          claimBatch: async (params) => {
            if (firstWave) {
              firstWave = false;
              waves.push([...params.types]);
              throw new TypeError('claim unavailable');
            }
            return [];
          },
        },
        now: () => Date.now(),
        onAfterDispatch: async () => undefined,
        workerId: 'dispatcher-test',
      });
    };

    const origin = Date.now();
    await expect(tick()).resolves.toEqual({ didWork: true });
    expect(waves).toEqual([[exportSpec.jobType, auditSpec.jobType]]);
    expect(error).toHaveBeenCalledWith('[platformJobsDispatcher] claim failed', {
      errorClass: 'TypeError',
      types: [exportSpec.jobType, auditSpec.jobType],
    });

    await tick();
    expect(waves).toHaveLength(1);

    const exportRetryAt = origin + delayAfter(exportSpec.intervalMs, 1);
    const auditRetryAt = origin + delayAfter(auditSpec.intervalMs, 1);
    expect(exportRetryAt).toBeLessThan(auditRetryAt);

    vi.advanceTimersByTime(exportRetryAt - Date.now() - 1);
    await tick();
    expect(waves).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await tick();
    expect(waves.at(-1)).toEqual([exportSpec.jobType]);

    vi.advanceTimersByTime(auditRetryAt - Date.now() - 1);
    await tick();
    expect(waves.at(-1)).toEqual([exportSpec.jobType]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(waves.at(-1)).toEqual([auditSpec.jobType]);
  });
});

describe('ensurePlatformJobsDispatcherStarted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('starts one loop at min(interval) and resets idle backoff when any type did work', async () => {
    const outcomes = [false, false, false, false, true, false];
    let attempts = 0;
    ensurePlatformJobsDispatcherStarted({
      enabledTypes: [spec('agentRollout'), spec('auditExport')],
      env: productionEnv,
      runTick: async () => {
        const didWork = outcomes[attempts] ?? false;
        attempts += 1;
        return { didWork };
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(4);
    // 4th dry run → next delay is 4× min(interval)=8s; that run did work → reset
    await vi.advanceTimersByTimeAsync(8000);
    expect(attempts).toBe(5);
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts).toBe(6);
  });

  it('does not start a timer when no types are enabled', async () => {
    const runTick = vi.fn();
    ensurePlatformJobsDispatcherStarted({
      enabledTypes: [],
      env: productionEnv,
      runTick,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTick).not.toHaveBeenCalled();
  });
});

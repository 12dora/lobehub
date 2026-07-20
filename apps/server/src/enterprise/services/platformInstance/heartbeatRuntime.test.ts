// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformInstanceRepository } from '@/database/repositories/platformInstance';
import type { LobeChatDatabase } from '@/database/type';

import {
  ensurePlatformInstanceHeartbeatStarted,
  getPlatformInstanceId,
  resetPlatformInstanceHeartbeatForTest,
  shouldStartPlatformInstanceHeartbeat,
} from './heartbeatRuntime';

const productionEnv = (): Record<string, string | undefined> => ({
  DATABASE_URL: 'postgresql://database.invalid/lobehub',
  ENABLE_PLATFORM_ADMIN: '1',
  NEXT_RUNTIME: 'nodejs',
  NODE_ENV: 'production',
});

const repository = () => ({
  registerInstance: vi.fn<PlatformInstanceRepository['registerInstance']>().mockResolvedValue({
    instanceId: getPlatformInstanceId(),
    lastHeartbeatAt: new Date(),
    startedAt: new Date(),
  }),
  upsertHeartbeat: vi.fn<PlatformInstanceRepository['upsertHeartbeat']>().mockResolvedValue({
    instanceId: getPlatformInstanceId(),
    lastHeartbeatAt: new Date(),
    startedAt: new Date(),
  }),
});

beforeEach(resetPlatformInstanceHeartbeatForTest);
afterEach(resetPlatformInstanceHeartbeatForTest);

describe('platform instance heartbeat runtime', () => {
  it('accepts only persistent production Node with a database and any enterprise flag', () => {
    expect(shouldStartPlatformInstanceHeartbeat(productionEnv())).toBe(true);
    expect(
      shouldStartPlatformInstanceHeartbeat({
        ...productionEnv(),
        ENABLE_PLATFORM_ADMIN: undefined,
        ENABLE_PLATFORM_MANAGED_SKILLS: 'yes',
      }),
    ).toBe(true);

    for (const unsupported of [
      { NODE_ENV: 'development' },
      { NEXT_RUNTIME: 'edge' },
      { NEXT_PHASE: 'phase-production-build' },
      { npm_lifecycle_event: 'build' },
      { VERCEL: '1' },
      { VERCEL_ENV: 'production' },
      { AWS_LAMBDA_FUNCTION_NAME: 'handler' },
      { AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x' },
      { DATABASE_URL: undefined },
      { ENABLE_PLATFORM_ADMIN: '0' },
    ]) {
      expect(shouldStartPlatformInstanceHeartbeat({ ...productionEnv(), ...unsupported })).toBe(
        false,
      );
    }
  });

  it('gates unsupported runtimes before database access or timer creation', async () => {
    const getDatabase = vi.fn();
    const schedule = vi.fn();

    await expect(
      ensurePlatformInstanceHeartbeatStarted({
        env: { ...productionEnv(), ENABLE_PLATFORM_ADMIN: '0' },
        getDatabase,
        schedule,
      }),
    ).resolves.toBe(false);

    expect(getDatabase).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('creates one stable process id and one unref timer across concurrent starts', async () => {
    const target = repository();
    const unref = vi.fn();
    const schedule = vi.fn(() => ({ unref }));
    const getDatabase = vi.fn(async () => ({}) as LobeChatDatabase);
    const createRepository = vi.fn(() => target);

    const results = await Promise.all([
      ensurePlatformInstanceHeartbeatStarted({
        createRepository,
        env: productionEnv(),
        getDatabase,
        schedule,
      }),
      ensurePlatformInstanceHeartbeatStarted({
        createRepository,
        env: productionEnv(),
        getDatabase,
        schedule,
      }),
    ]);

    expect(results).toEqual([true, true]);
    expect(getPlatformInstanceId()).toMatch(/^pinst_[a-f0-9]{48}$/);
    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(target.registerInstance).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('changes identity after a simulated process restart', () => {
    const first = getPlatformInstanceId();
    resetPlatformInstanceHeartbeatForTest();
    const second = getPlatformInstanceId();

    expect(second).not.toBe(first);
    expect(second).toMatch(/^pinst_[a-f0-9]{48}$/);
  });

  it('reports only the error class and starts no timer when registration fails', async () => {
    const logFailure = vi.fn();
    const schedule = vi.fn();

    await expect(
      ensurePlatformInstanceHeartbeatStarted({
        createRepository: () => ({
          registerInstance: vi.fn().mockRejectedValue(new TypeError('contains-sensitive-detail')),
          upsertHeartbeat: vi.fn(),
        }),
        env: productionEnv(),
        getDatabase: async () => ({}) as LobeChatDatabase,
        logFailure,
        schedule,
      }),
    ).resolves.toBe(false);

    expect(logFailure).toHaveBeenCalledWith({ errorClass: 'TypeError' });
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('contains-sensitive-detail');
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('pinst_');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('serializes timer ticks and reduces heartbeat failures to error class', async () => {
    const target = repository();
    let rejectHeartbeat: ((error: Error) => void) | undefined;
    target.upsertHeartbeat.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectHeartbeat = reject;
        }),
    );
    let tick: (() => void) | undefined;
    const logFailure = vi.fn();
    await ensurePlatformInstanceHeartbeatStarted({
      createRepository: () => target,
      env: productionEnv(),
      getDatabase: async () => ({}) as LobeChatDatabase,
      logFailure,
      schedule: (callback) => {
        tick = callback;
        return { unref: vi.fn() };
      },
    });

    tick?.();
    tick?.();
    expect(target.upsertHeartbeat).toHaveBeenCalledTimes(1);
    rejectHeartbeat?.(new RangeError('raw-heartbeat-detail'));
    await vi.waitFor(() => expect(logFailure).toHaveBeenCalledWith({ errorClass: 'RangeError' }));
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('raw-heartbeat-detail');
  });
});

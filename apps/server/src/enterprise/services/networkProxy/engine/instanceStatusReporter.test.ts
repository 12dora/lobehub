// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startInstanceStatusReporter } from './instanceStatusReporter';
import type { EngineRuntime } from './types';
import { idleEngineRuntimeState } from './types';

afterEach(() => {
  vi.useRealTimers();
});

const makeRuntime = (): EngineRuntime & { emit: () => void } => {
  const listeners = new Set<(state: ReturnType<EngineRuntime['getState']>) => void>();
  return {
    emit: () => {
      const state = idleEngineRuntimeState('running');
      for (const listener of listeners) listener(state);
    },
    getLogs: () => [],
    getState: () => idleEngineRuntimeState('running'),
    listNodes: async () => [],
    onStateChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshSubscriptionNow: async () => undefined,
    reloadConfig: async () => undefined,
    restart: async () => undefined,
    selectNode: async () => undefined,
    testGroupDelay: async () => [],
    testNodeDelay: async () => null,
  };
};

const waitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('startInstanceStatusReporter', () => {
  it('coalesces state-change ticks inside the debounce window', async () => {
    const report = vi.fn(async () => true);
    const runtime = makeRuntime();
    const stop = startInstanceStatusReporter(runtime, 30_000, report, 40);
    await waitMs(0);
    expect(report).toHaveBeenCalledTimes(1);

    runtime.emit();
    runtime.emit();
    runtime.emit();
    expect(report).toHaveBeenCalledTimes(1);

    await waitMs(50);
    expect(report).toHaveBeenCalledTimes(2);
    stop();
  });

  it('re-runs a write after an in-flight report finishes when a tick arrived mid-flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const report = vi.fn(async () => {
      started += 1;
      if (started === 1) await gate;
      return true;
    });
    const runtime = makeRuntime();
    const stop = startInstanceStatusReporter(runtime, 30_000, report, 40);
    await waitMs(0);
    expect(started).toBe(1);

    runtime.emit();
    expect(started).toBe(1);

    release();
    await waitMs(10);
    expect(report).toHaveBeenCalledTimes(2);
    stop();
  });

  it('lets the timer tick write even inside the debounce window', async () => {
    const report = vi.fn(async () => true);
    const runtime = makeRuntime();
    const stop = startInstanceStatusReporter(runtime, 30, report, 200);
    await waitMs(0);
    expect(report).toHaveBeenCalledTimes(1);

    await waitMs(40);
    expect(report).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not start a dirty re-run after stop()', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const report = vi.fn(async () => {
      started += 1;
      if (started === 1) await gate;
      return true;
    });
    const runtime = makeRuntime();
    const stop = startInstanceStatusReporter(runtime, 30_000, report, 40);
    await waitMs(0);
    expect(started).toBe(1);

    runtime.emit();
    expect(started).toBe(1);
    stop();
    release();
    await waitMs(20);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

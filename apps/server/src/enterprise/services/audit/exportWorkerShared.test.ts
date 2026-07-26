// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithPeriodicLeaseMaintenance } from './exportWorkerShared';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('runWithPeriodicLeaseMaintenance', () => {
  it('renews throughout a long task and stops after it settles', async () => {
    vi.useFakeTimers();
    let finishTask: (() => void) | undefined;
    const task = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    const heartbeat = vi.fn(async () => {});
    const running = runWithPeriodicLeaseMaintenance(() => task, heartbeat, 100);

    await vi.advanceTimersByTimeAsync(350);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    finishTask?.();
    await running;
    await vi.advanceTimersByTimeAsync(500);
    expect(heartbeat).toHaveBeenCalledTimes(3);
  });
});

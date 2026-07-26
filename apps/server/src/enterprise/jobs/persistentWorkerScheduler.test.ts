// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calculatePersistentWorkerRetryDelay,
  startPersistentWorkerScheduler,
} from './persistentWorkerScheduler';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('persistent worker scheduler', () => {
  it('backs off exponentially with jitter and caps the retry delay', () => {
    expect(calculatePersistentWorkerRetryDelay(1000, 1, 60_000, () => 0.5)).toBe(2000);
    expect(calculatePersistentWorkerRetryDelay(1000, 2, 60_000, () => 0.5)).toBe(4000);
    expect(calculatePersistentWorkerRetryDelay(1000, 20, 60_000, () => 1)).toBe(60_000);
    expect(calculatePersistentWorkerRetryDelay(1000, 1, 60_000, () => 0)).toBe(1600);
  });

  it('resets to the normal interval after a successful batch and never overlaps runs', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    let active = 0;
    let maxActive = 0;
    const scheduler = startPersistentWorkerScheduler({
      baseIntervalMs: 1000,
      namespace: 'test',
      random: () => 0.5,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        attempts += 1;
        active -= 1;
        if (attempts < 3) throw new Error('dependency unavailable');
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(4);
    expect(maxActive).toBe(1);
    scheduler.stop();
  });
});

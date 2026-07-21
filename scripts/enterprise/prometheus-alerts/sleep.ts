/**
 * Bounded async sleep for polling loops. Injectable for tests (no real delays).
 */
export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/** Default sleep used by runtime validators and probes. */
let activeSleep: SleepFn = realSleep;

export const sleepMs = (ms: number): Promise<void> => activeSleep(ms);

/** Test-only: replace sleep implementation (e.g. no-op or recorder). */
export const setSleepForTests = (fn: SleepFn): void => {
  activeSleep = fn;
};

export const resetSleepForTests = (): void => {
  activeSleep = realSleep;
};

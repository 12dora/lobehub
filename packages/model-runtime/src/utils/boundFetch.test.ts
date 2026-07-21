// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getBoundFetch,
  resetBoundFetchPatchForTests,
  runWithBoundFetch,
  type FetchLike,
} from './boundFetch';

const okResponse = () => new Response('ok', { status: 200 });

/**
 * Concurrent first-call races only matter when ALS is absent and both callers
 * hit `await import('node:async_hooks')` before either assigns STORE_KEY.
 * Reset clears that shared state so each round is a true cold start.
 */
const coldStart = () => {
  resetBoundFetchPatchForTests();
};

afterEach(() => {
  resetBoundFetchPatchForTests();
});

describe('runWithBoundFetch concurrent first-call ALS init', () => {
  const runConcurrentRound = async () => {
    coldStart();

    const originalFetch = vi.fn(async () => okResponse()) as unknown as FetchLike;
    globalThis.fetch = originalFetch;

    const fetchA = vi.fn(async () => new Response('a', { status: 200 })) as unknown as FetchLike;
    const fetchB = vi.fn(async () => new Response('b', { status: 200 })) as unknown as FetchLike;

    const observedBound: Array<FetchLike | undefined> = [];
    const observedViaGlobal: string[] = [];

    await Promise.all([
      runWithBoundFetch(fetchA, async () => {
        observedBound[0] = getBoundFetch();
        // Yield so the sibling concurrent first-call can interleave around
        // the dynamic import of node:async_hooks before we touch global fetch.
        await Promise.resolve();
        await Promise.resolve();
        const res = await globalThis.fetch('https://example.test/a');
        observedViaGlobal[0] = await res.text();
      }),
      runWithBoundFetch(fetchB, async () => {
        observedBound[1] = getBoundFetch();
        await Promise.resolve();
        await Promise.resolve();
        const res = await globalThis.fetch('https://example.test/b');
        observedViaGlobal[1] = await res.text();
      }),
    ]);

    // Each ALS context must still see its own binding (not undefined / sibling).
    expect(observedBound[0]).toBe(fetchA);
    expect(observedBound[1]).toBe(fetchB);

    // Patched global fetch must dispatch to the active binding, never original.
    expect(observedViaGlobal[0]).toBe('a');
    expect(observedViaGlobal[1]).toBe('b');
    expect(fetchA).toHaveBeenCalled();
    expect(fetchB).toHaveBeenCalled();
    expect(originalFetch).not.toHaveBeenCalled();
  };

  it('shares one ALS across concurrent cold starts and preserves each binding', async () => {
    await runConcurrentRound();
  });

  it('is re-runnable after resetBoundFetchPatchForTests clears shared keys', async () => {
    // First cold concurrent round.
    await runConcurrentRound();
    // Explicit reset + second cold concurrent round (regression harness).
    await runConcurrentRound();
  });
});

describe('runWithBoundFetch sequential binding', () => {
  it('binds only for the duration of fn and restores isolation afterward', async () => {
    coldStart();
    const originalFetch = vi.fn(async () => okResponse()) as unknown as FetchLike;
    globalThis.fetch = originalFetch;

    const bound = vi.fn(async () => new Response('bound', { status: 200 })) as unknown as FetchLike;

    await runWithBoundFetch(bound, async () => {
      expect(getBoundFetch()).toBe(bound);
      expect(await (await globalThis.fetch('https://example.test/in')).text()).toBe('bound');
    });

    expect(getBoundFetch()).toBeUndefined();
    expect(await (await globalThis.fetch('https://example.test/out')).text()).toBe('ok');
    expect(originalFetch).toHaveBeenCalledOnce();
  });
});

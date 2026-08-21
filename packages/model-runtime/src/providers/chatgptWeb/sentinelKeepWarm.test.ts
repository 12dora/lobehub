import { afterEach, describe, expect, it, vi } from 'vitest';

import { SENTINEL_BUNDLE_TTL_SEC } from './sentinel';
import type { MintedSentinelBundle, SentinelBundleBinding } from './sentinelBundlePool';
import { getSharedSentinelBundlePool, resetSharedSentinelBundlePool } from './sentinelBundlePool';
import {
  resetChatGPTWebSentinelKeepWarmForTests,
  SENTINEL_WARM_SKEW_MS,
  startChatGPTWebSentinelKeepWarm,
  stopChatGPTWebSentinelKeepWarm,
} from './sentinelKeepWarm';
import type { ChatRequirements } from './types';

const binding = (overrides: Partial<SentinelBundleBinding> = {}): SentinelBundleBinding => ({
  contextKey: 'ctx-warm',
  deviceId: 'device-1',
  profileId: 'chrome-150',
  sessionId: 'session-1',
  ...overrides,
});

const requirements = (token: string): ChatRequirements => ({
  proofToken: `proof-${token}`,
  soToken: `so-${token}`,
  token,
  turnstileToken: `turnstile-${token}`,
});

const minted = (token: string, expiresAtMs = Date.now() + 540_000): MintedSentinelBundle => ({
  expiresAtMs,
  requirements: requirements(token),
});

afterEach(() => {
  resetChatGPTWebSentinelKeepWarmForTests();
  resetSharedSentinelBundlePool();
  vi.useRealTimers();
});

describe('startChatGPTWebSentinelKeepWarm', () => {
  it('mints immediately without throwing', async () => {
    const mint = vi.fn(async () => minted(`t${mint.mock.calls.length}`));

    expect(() => startChatGPTWebSentinelKeepWarm(binding(), mint)).not.toThrow();
    await vi.waitFor(() => expect(mint.mock.calls.length).toBeGreaterThanOrEqual(2));

    const acquired = await getSharedSentinelBundlePool().acquire(binding(), mint);
    expect(acquired.requirements.token).toMatch(/^t\d+$/);
  });

  it('never throws into the caller when mint fails', async () => {
    const mint = vi.fn(async () => {
      throw new Error('finalize failed');
    });

    expect(() => startChatGPTWebSentinelKeepWarm(binding(), mint)).not.toThrow();
    await vi.waitFor(() => expect(mint).toHaveBeenCalled());
  });

  it('re-warms shortly before TTL expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(0);
    let n = 0;
    const mint = vi.fn(async () => minted(`t${(n += 1)}`, Date.now() + 540_000));

    startChatGPTWebSentinelKeepWarm(binding(), mint);
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(1));
    const firstWave = n;

    await vi.advanceTimersByTimeAsync(SENTINEL_BUNDLE_TTL_SEC * 1000 - SENTINEL_WARM_SKEW_MS);
    await vi.waitFor(() => expect(n).toBeGreaterThan(firstWave));
  });

  it('caps overlapping keep-warms at two concurrent mints', async () => {
    const gates: Array<() => void> = [];
    const mint = vi.fn(
      () =>
        new Promise<MintedSentinelBundle>((resolve) => {
          gates.push(() => resolve(minted(`t${gates.length}`)));
        }),
    );

    startChatGPTWebSentinelKeepWarm(binding({ contextKey: 'a' }), mint);
    startChatGPTWebSentinelKeepWarm(binding({ contextKey: 'b' }), mint);
    startChatGPTWebSentinelKeepWarm(binding({ contextKey: 'c' }), mint);

    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
    expect(gates).toHaveLength(2);

    gates[0]!();
    await vi.waitFor(() => expect(mint.mock.calls.length).toBeGreaterThan(2));
  });

  it('stop cancels a scheduled refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(0);
    const mint = vi.fn(async () => minted(`t${mint.mock.calls.length}`, Date.now() + 540_000));

    startChatGPTWebSentinelKeepWarm(binding(), mint);
    await vi.waitFor(() => expect(mint.mock.calls.length).toBeGreaterThanOrEqual(1));
    const afterWarm = mint.mock.calls.length;
    stopChatGPTWebSentinelKeepWarm('ctx-warm');

    await vi.advanceTimersByTimeAsync(SENTINEL_BUNDLE_TTL_SEC * 1000);
    expect(mint).toHaveBeenCalledTimes(afterWarm);
  });
});

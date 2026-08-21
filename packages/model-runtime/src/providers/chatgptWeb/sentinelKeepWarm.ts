import createDebug from 'debug';

import { describeThrownValue } from './errors';
import { SENTINEL_BUNDLE_TTL_SEC } from './sentinel';
import type { SentinelBundleBinding, SentinelBundleMintFn } from './sentinelBundlePool';
import { getSharedSentinelBundlePool } from './sentinelBundlePool';

const log = createDebug('lobe-chatgptweb:sentinel-pool');

/** Start the next mint this many ms before the parked bundle would expire. */
export const SENTINEL_WARM_SKEW_MS = 30_000;

/** Cap overlapping keep-warm handshakes across all accounts. */
const MAX_CONCURRENT_WARMS = 2;

const MIN_REFRESH_DELAY_MS = 1_000;

interface WarmSlot {
  binding: SentinelBundleBinding;
  generation: number;
  mint: SentinelBundleMintFn;
  timer?: ReturnType<typeof setTimeout>;
}

const slots = new Map<string, WarmSlot>();
let inFlight = 0;
const waiters: Array<() => void> = [];

const acquireConcurrency = async (): Promise<void> => {
  if (inFlight < MAX_CONCURRENT_WARMS) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
  inFlight += 1;
};

const releaseConcurrency = (): void => {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
};

const refreshDelayMs = (): number =>
  Math.max(MIN_REFRESH_DELAY_MS, SENTINEL_BUNDLE_TTL_SEC * 1000 - SENTINEL_WARM_SKEW_MS);

/**
 * Park ready Sentinel bundles for this context and refresh them shortly before
 * TTL. Failures are logged, never thrown: bind / rotate / runtime construction
 * must not fail because a background handshake hiccuped.
 */
export const startChatGPTWebSentinelKeepWarm = (
  binding: SentinelBundleBinding,
  mint: SentinelBundleMintFn,
): void => {
  try {
    const key = binding.contextKey;
    const existing = slots.get(key);
    if (existing) {
      // Idempotent: a reconstructed runtime must not push refresh past the
      // parked bundles' real expiry. Swap the mint closure; keep the timer.
      existing.mint = mint;
      existing.binding = binding;
      return;
    }
    const slot: WarmSlot = {
      binding,
      generation: 0,
      mint,
    };
    slots.set(key, slot);
    void runWarm(slot, { refreshExpiring: false });
  } catch (error) {
    log('keep-warm start failed: %s', describeThrownValue(error));
  }
};

export const stopChatGPTWebSentinelKeepWarm = (contextKey: string): void => {
  const slot = slots.get(contextKey);
  if (!slot) return;
  slot.generation += 1;
  if (slot.timer) clearTimeout(slot.timer);
  slots.delete(contextKey);
};

const isCurrent = (slot: WarmSlot): boolean => slots.get(slot.binding.contextKey) === slot;

const runWarm = async (slot: WarmSlot, { refreshExpiring }: { refreshExpiring: boolean }) => {
  const generation = slot.generation;
  try {
    await acquireConcurrency();
    try {
      if (!isCurrent(slot) || slot.generation !== generation) return;
      const pool = getSharedSentinelBundlePool();
      if (refreshExpiring)
        await pool.discardExpiring(slot.binding.contextKey, SENTINEL_WARM_SKEW_MS);
      await pool.warm(slot.binding, slot.mint);
    } finally {
      releaseConcurrency();
    }
  } catch (error) {
    log('keep-warm mint failed: %s', describeThrownValue(error));
  }
  if (!isCurrent(slot) || slot.generation !== generation) return;
  schedule(slot);
};

const schedule = (slot: WarmSlot): void => {
  if (slot.timer) clearTimeout(slot.timer);
  const earliest = getSharedSentinelBundlePool().earliestExpiryMs(slot.binding.contextKey);
  const delay =
    earliest === undefined
      ? refreshDelayMs()
      : Math.max(MIN_REFRESH_DELAY_MS, earliest - SENTINEL_WARM_SKEW_MS - Date.now());
  const timer = setTimeout(() => {
    slot.timer = undefined;
    void runWarm(slot, { refreshExpiring: true });
  }, delay);
  timer.unref?.();
  slot.timer = timer;
};

/** Test seam. Production code must not call this. */
export const resetChatGPTWebSentinelKeepWarmForTests = (): void => {
  for (const key of Array.from(slots.keys())) stopChatGPTWebSentinelKeepWarm(key);
  inFlight = 0;
  waiters.length = 0;
};

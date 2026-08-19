import createDebug from 'debug';

import { randomUuid } from './binary';
import { callerAbortReason } from './errors';
import type { ChatRequirements } from './types';

const log = createDebug('lobe-chatgptweb:sentinel-pool');

/** One ready bundle is enough: the next handshake overlaps the current stream. */
export const SENTINEL_READY_POOL_SIZE = 1;

/**
 * Opaque Browser Session Context key plus the ChatGPT identity the bundle was
 * minted under. `contextKey` is supplied by the caller (C1 will pass the
 * registry id later). Build markers are optional: a client that has not
 * bootstrapped yet must still be able to reuse a bundle minted by a sibling.
 */
export interface SentinelBundleBinding {
  clientBuildNumber?: string;
  clientVersion?: string;
  contextKey: string;
  deviceId: string;
  profileId: string;
  sessionId: string;
}

export interface MintedSentinelBundle {
  clientBuildNumber?: string;
  clientVersion?: string;
  expiresAtMs: number;
  requirements: ChatRequirements;
}

export interface AcquiredSentinelBundle {
  binding: SentinelBundleBinding;
  expiresAtMs: number;
  id: string;
  requirements: ChatRequirements;
}

export type SentinelBundleMintFn = (signal?: AbortSignal) => Promise<MintedSentinelBundle>;

/**
 * Provisional context key until C1 supplies the Browser Session Context id.
 * Never include credentials (access token, cookies) in this string.
 */
export const deriveSentinelContextKey = ({
  deviceId,
  profileId,
  sessionId,
}: {
  deviceId: string;
  profileId: string;
  sessionId: string;
}): string => `chatgptweb:${deviceId}:${sessionId}:${profileId}`;

type BundleState = 'consumed' | 'discarded' | 'ready';

interface InternalBundle {
  binding: SentinelBundleBinding;
  expiresAtMs: number;
  id: string;
  requirements: ChatRequirements;
  state: BundleState;
}

interface ContextSlot {
  binding?: SentinelBundleBinding;
  minting?: Promise<InternalBundle | undefined>;
  mutex: Mutex;
  ready: InternalBundle[];
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /**
   * `fn` must not return a thenable that re-enters this mutex: `async` will
   * flatten that promise and hold the lock until it settles (deadlock).
   * Return a wrapper object when handing a mint promise out of the lock.
   */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.tail;
    this.tail = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const identityMatches = (left: SentinelBundleBinding, right: SentinelBundleBinding): boolean =>
  left.contextKey === right.contextKey &&
  left.deviceId === right.deviceId &&
  left.profileId === right.profileId &&
  left.sessionId === right.sessionId;

/**
 * A bundle is superseded when the device/session/profile changed, or when both
 * sides carry live build markers that disagree. Missing markers (a fresh client
 * that has not bootstrapped) do not invalidate a sibling's ready bundle.
 */
export const isSentinelBindingSuperseded = (
  stored: SentinelBundleBinding,
  incoming: SentinelBundleBinding,
): boolean => {
  if (!identityMatches(stored, incoming)) return true;
  if (
    stored.clientVersion &&
    incoming.clientVersion &&
    stored.clientVersion !== incoming.clientVersion
  )
    return true;
  if (
    stored.clientBuildNumber &&
    incoming.clientBuildNumber &&
    stored.clientBuildNumber !== incoming.clientBuildNumber
  )
    return true;
  return false;
};

const mergeBinding = (
  base: SentinelBundleBinding,
  minted: Pick<MintedSentinelBundle, 'clientBuildNumber' | 'clientVersion'>,
): SentinelBundleBinding => ({
  ...base,
  clientBuildNumber: minted.clientBuildNumber ?? base.clientBuildNumber,
  clientVersion: minted.clientVersion ?? base.clientVersion,
});

const toAcquired = (bundle: InternalBundle): AcquiredSentinelBundle => ({
  binding: bundle.binding,
  expiresAtMs: bundle.expiresAtMs,
  id: bundle.id,
  requirements: bundle.requirements,
});

const withAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  const abortReason = callerAbortReason(signal);
  if (abortReason !== undefined) throw abortReason;
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(callerAbortReason(signal) ?? signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

/**
 * Process-local pool of single-use Sentinel bundles, keyed by context.
 *
 * Acquisition is serialized per context so concurrent turns cannot spend the
 * same proof. Minting happens outside the lock so a background replenish cannot
 * stall a turn that already has a ready bundle.
 */
export class SentinelBundlePool {
  private readonly maxReady: number;
  private readonly now: () => number;
  private readonly slots = new Map<string, ContextSlot>();

  constructor({
    maxReady = SENTINEL_READY_POOL_SIZE,
    now = Date.now,
  }: {
    maxReady?: number;
    now?: () => number;
  } = {}) {
    this.maxReady = maxReady;
    this.now = now;
  }

  /**
   * Atomically take one ready bundle, minting on a cold context. Only the first
   * turn on an empty pool blocks on the handshake.
   */
  async acquire(
    binding: SentinelBundleBinding,
    mint: SentinelBundleMintFn,
    signal?: AbortSignal,
  ): Promise<AcquiredSentinelBundle> {
    const slot = this.slotFor(binding.contextKey);

    for (;;) {
      const abortReason = callerAbortReason(signal);
      if (abortReason !== undefined) throw abortReason;

      const step = await slot.mutex.run(() => {
        this.adoptBinding(slot, binding);
        const ready = this.takeReady(slot);
        if (ready) return { bundle: ready, kind: 'ready' as const };
        if (slot.minting) return { kind: 'wait' as const, ours: false, promise: slot.minting };
        return {
          kind: 'wait' as const,
          ours: true,
          promise: this.startMint(slot, binding, mint, signal),
        };
      });

      if (step.kind === 'ready') return toAcquired(step.bundle);

      try {
        await withAbort(step.promise, signal);
      } catch (error) {
        if (step.ours || callerAbortReason(signal) !== undefined) throw error;
        // A sibling mint failed: leave the slot empty so this acquire retries.
      }
    }
  }

  /**
   * Park one ready bundle without consuming it. Call on context init/reconnect
   * so the first turn is not stalled behind a background warm that never started.
   */
  async warm(
    binding: SentinelBundleBinding,
    mint: SentinelBundleMintFn,
    signal?: AbortSignal,
  ): Promise<void> {
    const slot = this.slotFor(binding.contextKey);
    // Wrap the mint promise so the mutex does not flatten/await it — minting
    // must complete outside the lock (it re-enters the mutex to park the bundle).
    const step = await slot.mutex.run(() => {
      this.adoptBinding(slot, binding);
      this.prune(slot);
      if (this.hasReady(slot)) return { pending: undefined };
      if (slot.minting) return { pending: slot.minting };
      return { pending: this.startMint(slot, binding, mint, signal) };
    });
    if (step.pending) await step.pending;
  }

  /**
   * Fire-and-forget mint of the next bundle. Failures are logged, never thrown:
   * the current turn is already holding its own bundle, and the next acquire
   * will retry the handshake.
   */
  replenish(
    binding: SentinelBundleBinding,
    mint: SentinelBundleMintFn,
    signal?: AbortSignal,
  ): void {
    const slot = this.slotFor(binding.contextKey);
    void slot.mutex
      .run(() => {
        this.adoptBinding(slot, binding);
        this.prune(slot);
        if (this.hasReady(slot) || slot.minting) return;
        const pending = this.startMint(slot, binding, mint, signal);
        void pending.catch((error) => {
          log('replenish failed: %s', String(error));
        });
      })
      .catch((error) => {
        log('replenish failed: %s', String(error));
      });
  }

  /** Drop every parked/in-flight bundle for a context (reconnect, device change). */
  invalidate(contextKey: string): void {
    const slot = this.slots.get(contextKey);
    if (!slot) return;
    void slot.mutex
      .run(() => {
        this.discardReady(slot);
        slot.minting = undefined;
        slot.binding = undefined;
      })
      .catch((error) => {
        log('invalidate failed: %s', String(error));
      });
  }

  /** Test seam: drop all slots. Do not call while mints are in flight. */
  reset(): void {
    for (const slot of this.slots.values()) {
      this.discardReady(slot);
      slot.minting = undefined;
      slot.binding = undefined;
    }
    this.slots.clear();
  }

  private slotFor(contextKey: string): ContextSlot {
    const existing = this.slots.get(contextKey);
    if (existing) return existing;
    const created: ContextSlot = { mutex: new Mutex(), ready: [] };
    this.slots.set(contextKey, created);
    return created;
  }

  private adoptBinding(slot: ContextSlot, binding: SentinelBundleBinding): void {
    if (slot.binding && isSentinelBindingSuperseded(slot.binding, binding)) {
      this.discardReady(slot);
      slot.minting = undefined;
      slot.binding = binding;
      return;
    }
    slot.binding = slot.binding ? mergeBinding(binding, slot.binding) : binding;
  }

  private hasReady(slot: ContextSlot): boolean {
    this.prune(slot);
    return slot.ready.some((bundle) => bundle.state === 'ready');
  }

  private takeReady(slot: ContextSlot): InternalBundle | undefined {
    this.prune(slot);
    const next: InternalBundle[] = [];
    let taken: InternalBundle | undefined;
    for (const bundle of slot.ready) {
      if (bundle.state !== 'ready') continue;
      if (!taken) {
        bundle.state = 'consumed';
        taken = bundle;
        continue;
      }
      next.push(bundle);
    }
    slot.ready = next;
    return taken;
  }

  private prune(slot: ContextSlot): void {
    const now = this.now();
    const kept: InternalBundle[] = [];
    for (const bundle of slot.ready) {
      if (bundle.state !== 'ready') continue;
      if (bundle.expiresAtMs <= now) {
        bundle.state = 'discarded';
        continue;
      }
      if (slot.binding && isSentinelBindingSuperseded(bundle.binding, slot.binding)) {
        bundle.state = 'discarded';
        continue;
      }
      kept.push(bundle);
    }
    slot.ready = kept;
  }

  private discardReady(slot: ContextSlot): void {
    for (const bundle of slot.ready) bundle.state = 'discarded';
    slot.ready = [];
  }

  private startMint(
    slot: ContextSlot,
    binding: SentinelBundleBinding,
    mint: SentinelBundleMintFn,
    signal?: AbortSignal,
  ): Promise<InternalBundle | undefined> {
    const promise: Promise<InternalBundle | undefined> = (async () => {
      try {
        const minted = await mint(signal);
        return await slot.mutex.run(() => {
          if (slot.minting !== promise) return undefined;
          slot.minting = undefined;
          // The slot rotated to another device/session/profile while we were
          // solving — drop this proof rather than parking it under the new identity.
          if (slot.binding && !identityMatches(slot.binding, binding)) return undefined;
          const merged = mergeBinding(slot.binding ?? binding, minted);
          slot.binding = merged;
          if (minted.expiresAtMs <= this.now()) return undefined;
          const bundle: InternalBundle = {
            binding: merged,
            expiresAtMs: minted.expiresAtMs,
            id: randomUuid(),
            requirements: minted.requirements,
            state: 'ready',
          };
          slot.ready.push(bundle);
          this.trimReady(slot);
          return bundle;
        });
      } catch (error) {
        await slot.mutex.run(() => {
          if (slot.minting === promise) slot.minting = undefined;
        });
        throw error;
      }
    })();

    slot.minting = promise;
    return promise;
  }

  private trimReady(slot: ContextSlot): void {
    this.prune(slot);
    while (slot.ready.length > this.maxReady) {
      const extra = slot.ready.shift();
      if (extra) extra.state = 'discarded';
    }
  }
}

let sharedPool = new SentinelBundlePool();

export const getSharedSentinelBundlePool = (): SentinelBundlePool => sharedPool;

/** Test seam. Production code must not call this. */
export const resetSharedSentinelBundlePool = (): void => {
  sharedPool.reset();
  sharedPool = new SentinelBundlePool();
};

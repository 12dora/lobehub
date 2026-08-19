import { randomUUID } from 'node:crypto';

import debug from 'debug';

import { isPersistentEnterpriseWorkerRuntime } from '@/server/enterprise/jobs/persistentWorkerRuntime';

import {
  createBrowserCookieJar,
  resetBrowserCookieJars,
  sweepOrphanBrowserCookieJars,
} from './cookieJar';
import {
  buildBrowserSessionBindingDigest,
  buildBrowserSessionLookupKey,
  normalizeBrowserSessionAcquireInput,
  normalizeBrowserSessionIdentity,
} from './identity';
import {
  createBrowserSessionOwnerLease,
  disposeBrowserSessionResources,
  markBrowserSessionInvalidated,
  markBrowserSessionReleased,
} from './lifecycle';
import type { BrowserSessionTransportPool } from './transportPool';
import {
  buildBrowserSessionTransportPoolKey,
  createBrowserSessionTransportPool,
} from './transportPool';
import type {
  BrowserSessionAcquireInput,
  BrowserSessionContext,
  BrowserSessionContextSummary,
  BrowserSessionRegistry,
  BrowserSessionWriteFence,
} from './types';
import { BrowserSessionError } from './types';

const log = debug('lobe-server:browser-session');

/** Default cap on live contexts in this process. */
export const DEFAULT_BROWSER_SESSION_MAX_CONTEXTS = 256;
/** Idle TTL for ordinary (non-ephemeral) contexts. */
export const DEFAULT_BROWSER_SESSION_IDLE_TTL_MS = 45 * 60 * 1000;
/** Shorter TTL for adapter-marked throwaway / staged contexts. */
export const DEFAULT_BROWSER_SESSION_EPHEMERAL_IDLE_TTL_MS = 2 * 60 * 1000;
/** Persistent-worker sweep cadence. `0` = lazy-only (acquire / serverless). */
export const DEFAULT_BROWSER_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

export interface BrowserSessionRegistryOptions {
  cookieJarDirectory?: string;
  /**
   * Idle TTL for contexts with `providerState.ephemeral === true`.
   * Adapters set that flag (ChatGPT staged `:pending:` sessions); the common
   * sweeper never parses accountId.
   */
  ephemeralIdleTtlMs?: number;
  idleTtlMs?: number;
  maxContexts?: number;
  now?: () => number;
  ownerId?: string;
  /**
   * Interval for a timer-based sweep. `0` (default) is lazy-only. Persistent
   * worker runtimes start a process-level interval via
   * {@link startBrowserSessionIdleSweep} instead of per-registry timers.
   */
  sweepIntervalMs?: number;
  transportPool?: BrowserSessionTransportPool;
}

const summarizeContext = (context: BrowserSessionContext): BrowserSessionContextSummary => ({
  bindingDigest: context.bindingDigest,
  browserProfileRevision: context.browserProfileRevision,
  contextId: context.contextId,
  cookieJarDigest: context.cookieJar.digest,
  createdAt: context.createdAt,
  lastUsedAt: context.lastUsedAt,
  lifecycle: context.lifecycle,
  logicalPageId: context.logicalPageId,
  lookupKey: context.lookupKey,
  origin: context.origin,
  ownerId: context.ownerLease.ownerId,
  provider: context.provider,
  transportPoolKey: context.transportPoolKey,
});

export const summarizeBrowserSessionContext = summarizeContext;

export const isBrowserSessionWritable = (
  context: BrowserSessionContext,
  fence?: BrowserSessionWriteFence,
): boolean => {
  if (context.lifecycle !== 'active') return false;
  if (!fence) return true;
  return context.contextId === fence.contextId && context.revision === fence.revision;
};

export const assertWritable = (
  context: BrowserSessionContext,
  fence?: BrowserSessionWriteFence,
): boolean => isBrowserSessionWritable(context, fence);

export const getBrowserSessionProviderState = <T>(
  context: BrowserSessionContext,
  namespace: string,
): T | undefined => {
  if (context.lifecycle !== 'active') return undefined;
  return context.providerState[namespace] as T | undefined;
};

export const setBrowserSessionProviderState = <T>(
  context: BrowserSessionContext,
  namespace: string,
  state: T,
  fence?: BrowserSessionWriteFence,
): void => {
  if (!isBrowserSessionWritable(context, fence)) return;
  context.providerState[namespace] = state;
};

const isEphemeralContext = (context: BrowserSessionContext): boolean =>
  context.providerState.ephemeral === true;

const idleTtlFor = (
  context: BrowserSessionContext,
  idleTtlMs: number,
  ephemeralIdleTtlMs: number,
): number => (isEphemeralContext(context) ? ephemeralIdleTtlMs : idleTtlMs);

/**
 * Process-local registry. A later distributed lease can implement the same
 * {@link BrowserSessionRegistry} interface; do not add a remote backend here.
 *
 * Single-process assumption: ownerLease.ownerId is `pid:<pid>`. The idle
 * sweeper and boot jar sweep are only safe because this OS process is the
 * sole owner of `$TMPDIR` jars and the in-memory maps (plan principle 7).
 */
export const createBrowserSessionRegistry = (
  options: BrowserSessionRegistryOptions = {},
): BrowserSessionRegistry => {
  const now = options.now ?? Date.now;
  const transportPool = options.transportPool ?? createBrowserSessionTransportPool();
  const maxContexts = options.maxContexts ?? DEFAULT_BROWSER_SESSION_MAX_CONTEXTS;
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_BROWSER_SESSION_IDLE_TTL_MS;
  const ephemeralIdleTtlMs =
    options.ephemeralIdleTtlMs ?? DEFAULT_BROWSER_SESSION_EPHEMERAL_IDLE_TTL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? 0;
  const byContextId = new Map<string, BrowserSessionContext>();
  const byLookupKey = new Map<string, string>();
  const pendingCleanup: Promise<void>[] = [];
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  const enqueueCleanup = (work: Promise<void>): void => {
    const tracked = work.catch((error) => {
      log(
        'browser session cleanup failed: %s',
        error instanceof Error ? error.message : 'UnknownError',
      );
    });
    pendingCleanup.push(tracked);
    void tracked.finally(() => {
      const index = pendingCleanup.indexOf(tracked);
      if (index >= 0) pendingCleanup.splice(index, 1);
    });
  };

  const awaitPendingCleanup = async (): Promise<void> => {
    while (pendingCleanup.length > 0) {
      await Promise.all(pendingCleanup.slice());
    }
  };

  const drop = (context: BrowserSessionContext, next: 'invalidated' | 'released'): void => {
    // Fence first so closed-over handles fail writes before drain/unlink.
    context.revision += 1;
    if (next === 'released') markBrowserSessionReleased(context);
    else markBrowserSessionInvalidated(context);
    enqueueCleanup(disposeBrowserSessionResources(context, { transportPool }));
    byContextId.delete(context.contextId);
    if (byLookupKey.get(context.lookupKey) === context.contextId) {
      byLookupKey.delete(context.lookupKey);
    }
    log('%s context=%s lookup=%s', next, context.contextId, context.lookupKey);
  };

  const sweepIdleAndBound = (nowMs?: number, reserve = 0): number => {
    const at = nowMs ?? now();
    const cap = Math.max(0, maxContexts - reserve);
    const active = [...byContextId.values()].filter((context) => context.lifecycle === 'active');
    const idle = active.filter((context) => {
      if (context.inFlight > 0) return false;
      return at - context.lastUsedAt >= idleTtlFor(context, idleTtlMs, ephemeralIdleTtlMs);
    });
    // LRU: ephemeral first (throwaway staged contexts), then oldest lastUsedAt.
    idle.sort((left, right) => {
      const ephemeralDelta = Number(isEphemeralContext(right)) - Number(isEphemeralContext(left));
      if (ephemeralDelta !== 0) return ephemeralDelta;
      return left.lastUsedAt - right.lastUsedAt;
    });

    let evicted = 0;
    for (const context of idle) {
      drop(context, 'released');
      evicted += 1;
    }

    const remaining = [...byContextId.values()].filter((context) => context.lifecycle === 'active');
    if (remaining.length <= cap) return evicted;

    const overflow = remaining
      .filter((context) => context.inFlight === 0)
      .sort((left, right) => {
        const ephemeralDelta = Number(isEphemeralContext(right)) - Number(isEphemeralContext(left));
        if (ephemeralDelta !== 0) return ephemeralDelta;
        return left.lastUsedAt - right.lastUsedAt;
      });

    const need = remaining.length - cap;
    for (const context of overflow.slice(0, need)) {
      drop(context, 'released');
      evicted += 1;
    }

    const stillOver =
      [...byContextId.values()].filter((context) => context.lifecycle === 'active').length > cap;
    if (stillOver) {
      log(
        'maxContexts=%d reached with every remaining context in-flight; refusing to steal',
        maxContexts,
      );
    }
    return evicted;
  };

  const createContext = (
    input: ReturnType<typeof normalizeBrowserSessionAcquireInput>,
    lookupKey: string,
    bindingDigest: string,
  ): BrowserSessionContext => {
    const createdAt = now();
    const contextId = randomUUID();
    const cookieJar = createBrowserCookieJar({
      directoryName: options.cookieJarDirectory,
      key: contextId,
    });
    const context: BrowserSessionContext = {
      bindingDigest,
      browserProfileRevision: input.browserProfileRevision,
      contextId,
      cookieJar,
      createdAt,
      inFlight: 0,
      lastUsedAt: createdAt,
      lifecycle: 'active',
      logicalPageId: randomUUID(),
      lookupKey,
      origin: input.origin,
      ownerLease: createBrowserSessionOwnerLease({
        now: createdAt,
        ownerId: input.ownerId ?? options.ownerId,
      }),
      provider: input.provider,
      providerState: input.ephemeral ? { ephemeral: true } : {},
      revision: 1,
      transportPoolKey: buildBrowserSessionTransportPoolKey({
        contextId,
        impersonationProfileRevision: input.impersonationProfileRevision,
        origin: input.origin,
        proxyOutlet: input.proxyOutlet,
      }),
    };
    byContextId.set(contextId, context);
    byLookupKey.set(lookupKey, contextId);
    log('acquired context=%s lookup=%s provider=%s', contextId, lookupKey, input.provider);
    return context;
  };

  const acquire = (raw: BrowserSessionAcquireInput): BrowserSessionContext => {
    sweepIdleAndBound();
    const input = normalizeBrowserSessionAcquireInput(raw);
    const lookupKey = buildBrowserSessionLookupKey(input);
    const bindingDigest = buildBrowserSessionBindingDigest(input);
    const existingId = byLookupKey.get(lookupKey);
    const existing = existingId ? byContextId.get(existingId) : undefined;

    if (existing && existing.lifecycle === 'active') {
      if (existing.bindingDigest === bindingDigest) {
        existing.lastUsedAt = now();
        log('reused context=%s lookup=%s', existing.contextId, lookupKey);
        return existing;
      }
      drop(existing, 'invalidated');
    }

    const activeCount = [...byContextId.values()].filter(
      (context) => context.lifecycle === 'active',
    ).length;
    if (activeCount >= maxContexts) {
      if (input.ephemeral) {
        const victim = [...byContextId.values()]
          .filter(
            (context) =>
              context.lifecycle === 'active' &&
              context.inFlight === 0 &&
              isEphemeralContext(context),
          )
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
        if (!victim) {
          throw new BrowserSessionError('browser session context limit reached');
        }
        drop(victim, 'released');
      } else {
        sweepIdleAndBound(undefined, 1);
        const still = [...byContextId.values()].filter(
          (context) => context.lifecycle === 'active',
        ).length;
        if (still >= maxContexts) {
          throw new BrowserSessionError('browser session context limit reached');
        }
      }
    }

    return createContext(input, lookupKey, bindingDigest);
  };

  const get = (contextId: string): BrowserSessionContext | undefined => byContextId.get(contextId);

  const getForIdentity = (
    input: Pick<BrowserSessionAcquireInput, 'accountId' | 'origin' | 'provider'>,
  ): BrowserSessionContext | undefined => {
    const lookupKey = buildBrowserSessionLookupKey(normalizeBrowserSessionIdentity(input));
    const contextId = byLookupKey.get(lookupKey);
    if (!contextId) return undefined;
    const context = byContextId.get(contextId);
    if (!context || context.lifecycle !== 'active') return undefined;
    return context;
  };

  const invalidate = (contextId: string): boolean => {
    const context = byContextId.get(contextId);
    if (!context) return false;
    drop(context, 'invalidated');
    return true;
  };

  const invalidateForIdentity = (
    input: Pick<BrowserSessionAcquireInput, 'accountId' | 'origin' | 'provider'>,
  ): boolean => {
    const lookupKey = buildBrowserSessionLookupKey(normalizeBrowserSessionIdentity(input));
    const contextId = byLookupKey.get(lookupKey);
    if (!contextId) return false;
    return invalidate(contextId);
  };

  const touch = (contextId: string): boolean => {
    const context = byContextId.get(contextId);
    if (!context || context.lifecycle !== 'active') return false;
    context.lastUsedAt = now();
    return true;
  };

  const release = (contextId: string): boolean => {
    const context = byContextId.get(contextId);
    if (!context) return false;
    drop(context, 'released');
    return true;
  };

  const withContextOwnership = async <T>(
    contextId: string,
    fn: (ctx: BrowserSessionContext, fence: BrowserSessionWriteFence) => T | Promise<T>,
  ): Promise<T> => {
    const context = byContextId.get(contextId);
    if (!context || context.lifecycle !== 'active') {
      throw new BrowserSessionError('browser session context is not writable');
    }
    const fence: BrowserSessionWriteFence = {
      contextId: context.contextId,
      revision: context.revision,
    };
    context.inFlight += 1;
    context.lastUsedAt = now();
    context.ownerLease.acquiredAt = context.lastUsedAt;
    try {
      return await fn(context, fence);
    } finally {
      if (context.inFlight > 0) context.inFlight -= 1;
    }
  };

  const stopSweepTimer = (): void => {
    if (!sweepTimer) return;
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  };

  const dispose = (): void => {
    stopSweepTimer();
    for (const context of Array.from(byContextId.values())) drop(context, 'released');
    const leftover = transportPool.drainAll?.();
    if (leftover) enqueueCleanup(Promise.resolve(leftover).then(() => undefined));
  };

  if (sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      sweepIdleAndBound();
    }, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  return {
    acquire,
    awaitPendingCleanup,
    dispose,
    get,
    getForIdentity,
    invalidate,
    invalidateForIdentity,
    release,
    sweepIdleAndBound,
    summarize: summarizeContext,
    touch,
    withContextOwnership,
  };
};

let defaultRegistry: BrowserSessionRegistry | undefined;
let defaultSweepTimer: ReturnType<typeof setInterval> | undefined;
let orphanSweepDone = false;

const maybeSweepOrphansOnFirstUse = (): void => {
  if (orphanSweepDone) return;
  orphanSweepDone = true;
  // Vitest workers share `$TMPDIR`; a boot wipe would unlink sibling files.
  if (process.env.VITEST) return;
  sweepOrphanBrowserCookieJars();
};

/**
 * Process-local singleton. First use also runs the orphan-jar sweep when
 * enterprise workers did not boot (dev / tests that skip workers).
 */
export const getBrowserSessionRegistry = (): BrowserSessionRegistry => {
  if (!defaultRegistry) {
    maybeSweepOrphansOnFirstUse();
    defaultRegistry = createBrowserSessionRegistry();
  }
  return defaultRegistry;
};

/**
 * Timer sweep for long-lived Node processes. No-op on serverless / edge.
 * Single-process: this interval is the only sweeper for the default registry.
 */
export const startBrowserSessionIdleSweep = (): void => {
  if (!isPersistentEnterpriseWorkerRuntime()) return;
  if (defaultSweepTimer) return;
  const registry = getBrowserSessionRegistry();
  defaultSweepTimer = setInterval(() => {
    registry.sweepIdleAndBound();
  }, DEFAULT_BROWSER_SESSION_SWEEP_INTERVAL_MS);
  defaultSweepTimer.unref?.();
};

export const stopBrowserSessionIdleSweep = (): void => {
  if (!defaultSweepTimer) return;
  clearInterval(defaultSweepTimer);
  defaultSweepTimer = undefined;
};

export const disposeAllBrowserSessions = async (): Promise<void> => {
  stopBrowserSessionIdleSweep();
  const registry = defaultRegistry;
  registry?.dispose();
  await registry?.awaitPendingCleanup();
  defaultRegistry = undefined;
  resetBrowserCookieJars();
};

export const installBrowserSessionRegistryForTests = (registry: BrowserSessionRegistry): void => {
  defaultRegistry = registry;
};

export const resetBrowserSessionRegistryForTests = (): void => {
  stopBrowserSessionIdleSweep();
  const registry = defaultRegistry;
  registry?.dispose();
  void registry?.awaitPendingCleanup();
  defaultRegistry = undefined;
};

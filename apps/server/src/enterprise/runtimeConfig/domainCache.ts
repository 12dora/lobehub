import type { EnterpriseCacheDomain } from '@lobechat/observability-otel/modules/enterprise-platform';

import { classifyEnterpriseError, observeEnterprisePlatformEvent } from '../observability';
import { getPlatformConfigCacheTtlMs } from './config';

const MIN_CACHE_TTL_MS = 1;
const MAX_CACHE_TTL_MS = 300_000;
const UNAVAILABLE_SCOPE_EPOCH = '__platform_config_epoch_unavailable__';

interface CacheEntry<T> {
  expiresAt: number;
  value: T | null;
}

interface InflightLoad<T> {
  generation: number;
  promise: Promise<T | null>;
}

interface DomainCacheState<T> {
  entry?: CacheEntry<T>;
  epoch?: string;
  generation: number;
  inflight?: InflightLoad<T>;
  namespaceGeneration: number;
}

interface StoredDomainCacheState extends DomainCacheState<unknown> {}

export interface DomainConfigCacheOptions<T> {
  cacheId: string;
  cacheKey: object;
  cacheTtlMs?: number;
  cloneValue: (value: T) => T;
  getScopeEpoch: () => Promise<string>;
  load: () => Promise<T | null>;
  namespace: string;
  now?: () => number;
  observabilityDomain: EnterpriseCacheDomain;
  onEntryStored?: (value: T | null) => void;
  onLoadFailure?: (error: unknown) => void;
}

let statesByCacheKey = new WeakMap<object, Map<string, StoredDomainCacheState>>();
const namespaceGenerations = new Map<string, number>();

const getNamespaceGeneration = (namespace: string) => namespaceGenerations.get(namespace) ?? 0;

const normalizeTtlMs = (ttlMs: number | undefined): number => {
  const fallback = getPlatformConfigCacheTtlMs();
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return fallback;

  return Math.min(MAX_CACHE_TTL_MS, Math.max(MIN_CACHE_TTL_MS, Math.trunc(ttlMs)));
};

const cloneNullable = <T>(value: T | null, cloneValue: (value: T) => T): T | null =>
  value === null ? null : cloneValue(value);

const getStoredState = (cacheKey: object, cacheId: string): StoredDomainCacheState | undefined =>
  statesByCacheKey.get(cacheKey)?.get(cacheId);

const getOrCreateState = <T>(
  cacheKey: object,
  cacheId: string,
  namespaceGeneration: number,
): DomainCacheState<T> => {
  let states = statesByCacheKey.get(cacheKey);
  if (!states) {
    states = new Map();
    statesByCacheKey.set(cacheKey, states);
  }

  const existing = states.get(cacheId) as DomainCacheState<T> | undefined;
  if (existing) return existing;

  const state: DomainCacheState<T> = { generation: 0, namespaceGeneration };
  states.set(cacheId, state as StoredDomainCacheState);
  return state;
};

const expireState = <T>(state: DomainCacheState<T>, namespaceGeneration: number): void => {
  state.entry = undefined;
  state.epoch = undefined;
  state.generation += 1;
  state.inflight = undefined;
  state.namespaceGeneration = namespaceGeneration;
};

const errorClass = (error: unknown): string =>
  error instanceof Error && error.name ? error.name : 'UnknownError';

/**
 * Shared, bounded cache for a domain's active database projection.
 *
 * The scope epoch is only an invalidation hint. Database loaders remain authoritative, while a
 * bounded TTL guarantees convergence when the epoch reader is disabled, unavailable or loses an
 * event. Values (including null) are cached; loader failures are never cached.
 */
export class DomainConfigCache<T> {
  private readonly cacheKey: object;
  private readonly cacheTtlMs: number;
  private readonly cloneValue: (value: T) => T;
  private readonly getScopeEpoch: () => Promise<string>;
  private readonly load: () => Promise<T | null>;
  private readonly namespace: string;
  private readonly now: () => number;
  private readonly observabilityDomain: EnterpriseCacheDomain;
  private readonly onEntryStored?: (value: T | null) => void;
  private readonly onLoadFailure?: (error: unknown) => void;
  private readonly stateKey: string;

  constructor(options: DomainConfigCacheOptions<T>) {
    this.cacheKey = options.cacheKey;
    this.cacheTtlMs = normalizeTtlMs(options.cacheTtlMs);
    this.cloneValue = options.cloneValue;
    this.getScopeEpoch = options.getScopeEpoch;
    this.load = options.load;
    this.namespace = options.namespace;
    this.now = options.now ?? Date.now;
    this.observabilityDomain = options.observabilityDomain;
    this.onEntryStored = options.onEntryStored;
    this.onLoadFailure = options.onLoadFailure;
    this.stateKey = `${options.namespace}\0${options.cacheId}`;
  }

  private readScopeEpoch = async (): Promise<{ epoch: string; failed: boolean }> => {
    try {
      return { epoch: await this.getScopeEpoch(), failed: false };
    } catch (error) {
      console.error('[PlatformRuntimeConfig] scope epoch unavailable; using TTL fallback', {
        errorClass: errorClass(error),
      });
      observeEnterprisePlatformEvent({
        domain: this.observabilityDomain,
        operation: 'epoch',
        outcome: 'failure',
        type: 'cache',
      });
      return { epoch: UNAVAILABLE_SCOPE_EPOCH, failed: true };
    }
  };

  get = async (): Promise<T | null> => {
    const { epoch, failed } = await this.readScopeEpoch();
    const namespaceGeneration = getNamespaceGeneration(this.namespace);
    const state = getOrCreateState<T>(this.cacheKey, this.stateKey, namespaceGeneration);

    if (state.namespaceGeneration !== namespaceGeneration) {
      expireState(state, namespaceGeneration);
    }
    const epochChanged = state.epoch !== undefined && state.epoch !== epoch;
    if (!failed) {
      observeEnterprisePlatformEvent({
        domain: this.observabilityDomain,
        operation: 'epoch',
        outcome: epochChanged ? 'changed' : 'success',
        type: 'cache',
      });
    }
    if (state.epoch !== epoch) {
      state.entry = undefined;
      state.epoch = epoch;
      state.generation += 1;
      state.inflight = undefined;
    }

    const now = this.now();
    if (state.entry && state.entry.expiresAt > now) {
      observeEnterprisePlatformEvent({
        domain: this.observabilityDomain,
        operation: 'request',
        outcome: state.entry.value === null ? 'negative' : 'hit',
        type: 'cache',
      });
      return cloneNullable(state.entry.value, this.cloneValue);
    }

    if (state.inflight?.generation === state.generation) {
      observeEnterprisePlatformEvent({
        domain: this.observabilityDomain,
        operation: 'request',
        outcome: 'coalesced',
        type: 'cache',
      });
      return cloneNullable(await state.inflight.promise, this.cloneValue);
    }

    const generation = state.generation;
    const request = this.load();
    state.inflight = { generation, promise: request };
    const isAuthoritativeFlight = (): boolean =>
      getStoredState(this.cacheKey, this.stateKey) === state &&
      state.generation === generation &&
      state.namespaceGeneration === getNamespaceGeneration(this.namespace) &&
      state.inflight?.promise === request;

    try {
      const value = await request;
      observeEnterprisePlatformEvent({
        domain: this.observabilityDomain,
        operation: 'load',
        outcome: value === null ? 'loaded_negative' : 'loaded',
        type: 'cache',
      });
      if (isAuthoritativeFlight()) {
        state.entry = {
          expiresAt: this.now() + this.cacheTtlMs,
          value: cloneNullable(value, this.cloneValue),
        };
        try {
          this.onEntryStored?.(cloneNullable(value, this.cloneValue));
        } catch (error) {
          console.error('[PlatformRuntimeConfig] cache entry observer unavailable', {
            errorClass: errorClass(error),
          });
        }
      }
      return cloneNullable(value, this.cloneValue);
    } catch (error) {
      observeEnterprisePlatformEvent({
        domain: this.observabilityDomain,
        errorClass: classifyEnterpriseError(error),
        operation: 'load',
        outcome: 'load_failure',
        type: 'cache',
      });
      if (isAuthoritativeFlight()) {
        try {
          this.onLoadFailure?.(error);
        } catch (observerError) {
          console.error('[PlatformRuntimeConfig] cache failure observer unavailable', {
            errorClass: errorClass(observerError),
          });
        }
      }
      throw error;
    } finally {
      if (state.generation === generation && state.inflight?.promise === request) {
        state.inflight = undefined;
      }
    }
  };

  invalidate = (): void => {
    const state = getStoredState(this.cacheKey, this.stateKey) as DomainCacheState<T> | undefined;
    if (state) expireState(state, getNamespaceGeneration(this.namespace));
  };
}

export const invalidateDomainConfigCacheNamespace = (namespace: string): void => {
  namespaceGenerations.set(namespace, getNamespaceGeneration(namespace) + 1);
};

export const resetDomainConfigCachesForTest = (): void => {
  statesByCacheKey = new WeakMap<object, Map<string, StoredDomainCacheState>>();
  namespaceGenerations.clear();
};

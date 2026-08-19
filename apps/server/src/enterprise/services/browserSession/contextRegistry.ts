import { randomUUID } from 'node:crypto';

import debug from 'debug';

import { createBrowserCookieJar } from './cookieJar';
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
} from './types';

const log = debug('lobe-server:browser-session');

export interface BrowserSessionRegistryOptions {
  cookieJarDirectory?: string;
  now?: () => number;
  ownerId?: string;
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

export const getBrowserSessionProviderState = <T>(
  context: BrowserSessionContext,
  namespace: string,
): T | undefined => context.providerState[namespace] as T | undefined;

export const setBrowserSessionProviderState = <T>(
  context: BrowserSessionContext,
  namespace: string,
  state: T,
): void => {
  context.providerState[namespace] = state;
};

/**
 * Process-local registry. A later distributed lease can implement the same
 * {@link BrowserSessionRegistry} interface; do not add a remote backend here.
 */
export const createBrowserSessionRegistry = (
  options: BrowserSessionRegistryOptions = {},
): BrowserSessionRegistry => {
  const now = options.now ?? Date.now;
  const transportPool = options.transportPool ?? createBrowserSessionTransportPool();
  const byContextId = new Map<string, BrowserSessionContext>();
  const byLookupKey = new Map<string, string>();

  const drop = (context: BrowserSessionContext, next: 'invalidated' | 'released'): void => {
    if (next === 'released') markBrowserSessionReleased(context);
    else markBrowserSessionInvalidated(context);
    disposeBrowserSessionResources(context, { transportPool });
    byContextId.delete(context.contextId);
    if (byLookupKey.get(context.lookupKey) === context.contextId) {
      byLookupKey.delete(context.lookupKey);
    }
    log('%s context=%s lookup=%s', next, context.contextId, context.lookupKey);
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
      providerState: {},
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

    return createContext(input, lookupKey, bindingDigest);
  };

  const get = (contextId: string): BrowserSessionContext | undefined => byContextId.get(contextId);

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

  const dispose = (): void => {
    for (const context of Array.from(byContextId.values())) drop(context, 'released');
  };

  return {
    acquire,
    dispose,
    get,
    invalidate,
    invalidateForIdentity,
    release,
    summarize: summarizeContext,
    touch,
  };
};

let defaultRegistry: BrowserSessionRegistry | undefined;

export const getBrowserSessionRegistry = (): BrowserSessionRegistry => {
  defaultRegistry ??= createBrowserSessionRegistry();
  return defaultRegistry;
};

export const resetBrowserSessionRegistryForTests = (): void => {
  defaultRegistry?.dispose();
  defaultRegistry = undefined;
};

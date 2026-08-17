/**
 * Concurrent-safe binding of a custom fetch implementation for SDKs that only
 * read the global `fetch` (notably @google/genai ApiClient).
 *
 * The AsyncLocalStorage instance is stored on `Symbol.for(...)` so every module
 * graph that loads this file shares one store (avoids dual-package ALS splits).
 *
 * The global is patched once; when no binding is active the original fetch runs.
 *
 * `node:async_hooks` is loaded only when a bound fetch is actually used (server
 * enterprise connection-test / custom transport paths). Top-level stays free of
 * Node builtins so SPA production bundlers do not hard-fail or inject a dead
 * externalized import that would throw if the chunk ever executed in-browser.
 */
import type { AsyncLocalStorage } from 'node:async_hooks';

export type FetchLike = typeof fetch;

const STORE_KEY = Symbol.for('lobe.model-runtime.boundFetch.als');
const PATCHED_KEY = Symbol.for('lobe.model-runtime.boundFetch.patched');
const ORIGINAL_KEY = Symbol.for('lobe.model-runtime.boundFetch.original');

type GlobalBinding = typeof globalThis & {
  [ORIGINAL_KEY]?: FetchLike;
  [PATCHED_KEY]?: boolean;
  [STORE_KEY]?: AsyncLocalStorage<FetchLike>;
};

const getStoreIfPresent = (): AsyncLocalStorage<FetchLike> | undefined => {
  return (globalThis as GlobalBinding)[STORE_KEY];
};

/**
 * Lazily create the shared ALS. After `await import(...)` re-check STORE_KEY so
 * concurrent first callers share one instance (otherwise the later assignment
 * would replace the ALS the earlier `store.run()` still holds, and the patched
 * global fetch — which always reads STORE_KEY — would miss that binding and
 * fall through to unrestricted original fetch).
 */
const getOrCreateStore = async (): Promise<AsyncLocalStorage<FetchLike>> => {
  const g = globalThis as GlobalBinding;
  if (g[STORE_KEY]) return g[STORE_KEY];
  const { AsyncLocalStorage } = await import('node:async_hooks');
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = new AsyncLocalStorage<FetchLike>();
  }
  return g[STORE_KEY];
};

const ensureGlobalFetchPatch = (): void => {
  const g = globalThis as GlobalBinding;
  if (g[PATCHED_KEY]) return;

  const original = globalThis.fetch.bind(globalThis) as FetchLike;
  g[ORIGINAL_KEY] = original;
  g[PATCHED_KEY] = true;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const bound = getStoreIfPresent()?.getStore();
    const impl = bound ?? g[ORIGINAL_KEY];
    if (!impl) {
      throw new TypeError('fetch is not available');
    }
    return impl(input, init);
  }) as FetchLike;
};

/**
 * Run `fn` so every nested `globalThis.fetch` call uses `fetchImpl`.
 * OpenAI/Anthropic-style SDKs that accept an explicit `fetch` option should still
 * receive that option; this path covers providers that ignore it.
 */
export const runWithBoundFetch = async <T>(
  fetchImpl: FetchLike,
  fn: () => Promise<T>,
): Promise<T> => {
  ensureGlobalFetchPatch();
  const store = await getOrCreateStore();
  return store.run(fetchImpl, fn);
};

/**
 * Synchronous ALS enter. `store.run(value, fn)` returns `fn()`'s value as-is
 * (a string stays a string; a Promise stays a Promise) while still propagating
 * the store into any promise/async continuation created inside `fn`.
 *
 * Used by MarketService wrapping so `getSkillDownloadUrl()` / `getSDK()` do
 * not become Promises. Server-only: never called from the SPA bundle.
 */
const loadAlsCtorSync = (): typeof AsyncLocalStorage => {
  const proc = globalThis.process as
    | { getBuiltinModule?: (id: string) => { AsyncLocalStorage?: typeof AsyncLocalStorage } }
    | undefined;
  const fromBuiltin =
    proc?.getBuiltinModule?.('async_hooks') ?? proc?.getBuiltinModule?.('node:async_hooks');
  if (fromBuiltin?.AsyncLocalStorage) return fromBuiltin.AsyncLocalStorage;
  try {
    const req = (
      globalThis as { require?: (id: string) => { AsyncLocalStorage: typeof AsyncLocalStorage } }
    ).require;
    const hooks = req?.('node:async_hooks');
    if (hooks?.AsyncLocalStorage) return hooks.AsyncLocalStorage;
  } catch {
    // fall through
  }
  throw new TypeError('runWithBoundFetchSync requires Node.js async_hooks');
};

const getOrCreateStoreSync = (): AsyncLocalStorage<FetchLike> => {
  const existing = getStoreIfPresent();
  if (existing) return existing;
  const g = globalThis as GlobalBinding;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = new (loadAlsCtorSync())<FetchLike>();
  }
  return g[STORE_KEY];
};

export const runWithBoundFetchSync = <T>(fetchImpl: FetchLike, fn: () => T): T => {
  ensureGlobalFetchPatch();
  return getOrCreateStoreSync().run(fetchImpl, fn);
};

/** Read the currently bound fetch, if any (tests / diagnostics). */
export const getBoundFetch = (): FetchLike | undefined => getStoreIfPresent()?.getStore();

/**
 * Test helper: restore the pre-patch global fetch and clear shared binding
 * state so suites can re-run concurrent first-call scenarios.
 * Not used in production paths.
 */
export const resetBoundFetchPatchForTests = (): void => {
  const g = globalThis as GlobalBinding;
  if (g[ORIGINAL_KEY]) {
    globalThis.fetch = g[ORIGINAL_KEY];
  }
  delete g[PATCHED_KEY];
  delete g[ORIGINAL_KEY];
  // STORE_KEY is on globalThis via Symbol.for — re-importing the module does
  // not create a new ALS; only an explicit delete resets the shared instance.
  delete g[STORE_KEY];
};

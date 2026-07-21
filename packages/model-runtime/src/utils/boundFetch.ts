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

const getOrCreateStore = async (): Promise<AsyncLocalStorage<FetchLike>> => {
  const g = globalThis as GlobalBinding;
  if (g[STORE_KEY]) return g[STORE_KEY];
  const { AsyncLocalStorage } = await import('node:async_hooks');
  g[STORE_KEY] = new AsyncLocalStorage<FetchLike>();
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

/** Read the currently bound fetch, if any (tests / diagnostics). */
export const getBoundFetch = (): FetchLike | undefined => getStoreIfPresent()?.getStore();

/**
 * Test helper: restore the pre-patch global fetch so suites can install adversarial traps.
 * Not used in production paths.
 */
export const resetBoundFetchPatchForTests = (): void => {
  const g = globalThis as GlobalBinding;
  if (g[ORIGINAL_KEY]) {
    globalThis.fetch = g[ORIGINAL_KEY];
  }
  delete g[PATCHED_KEY];
  delete g[ORIGINAL_KEY];
  // Keep STORE_KEY so concurrent tests that already entered runWithBoundFetch
  // still see a coherent ALS; callers that need a clean ALS can re-import.
};

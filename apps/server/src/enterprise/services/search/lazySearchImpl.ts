/**
 * Memoized lazy SearchServiceImpl: import the provider module once, then
 * delegate `query`. Used by the upstream factory so that file keeps its switch.
 */
import type { SearchParams, UniformSearchResponse } from '@lobechat/types';

import type { SearchServiceImpl } from '@/server/services/search/impls/type';

type SearchImplConstructor = new () => SearchServiceImpl;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isImplConstructor = (value: unknown): value is SearchImplConstructor =>
  typeof value === 'function';

const resolveImplConstructor = (mod: unknown): SearchImplConstructor => {
  if (isImplConstructor(mod)) return mod;
  if (isRecord(mod) && isImplConstructor(mod.default)) return mod.default;
  if (isRecord(mod)) {
    const ctors = Object.values(mod).filter(isImplConstructor);
    if (ctors.length === 1) return ctors[0];
  }
  throw new Error('lazySearchImpl: expected exactly one SearchServiceImpl export');
};

export interface LazySearchImplOptions {
  useAutoSearchEngineSelection?: boolean;
}

export const lazySearchImpl = (
  load: () => Promise<unknown>,
  options?: LazySearchImplOptions,
): SearchServiceImpl => {
  let impl: SearchServiceImpl | undefined;
  let pending: Promise<SearchServiceImpl> | undefined;

  const resolve = async (): Promise<SearchServiceImpl> => {
    if (impl) return impl;
    pending ??= load().then((mod) => {
      impl = new (resolveImplConstructor(mod))();
      return impl;
    });
    return pending;
  };

  return {
    useAutoSearchEngineSelection: options?.useAutoSearchEngineSelection,
    query: async (query: string, params?: SearchParams): Promise<UniformSearchResponse> =>
      (await resolve()).query(query, params),
  };
};

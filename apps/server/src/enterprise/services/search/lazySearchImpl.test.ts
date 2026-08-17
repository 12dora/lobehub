// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSearchServiceImpl, SearchImplType } from '@/server/services/search/impls';

import { lazySearchImpl } from './lazySearchImpl';

describe('lazySearchImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not import at evaluation time', () => {
    const load = vi.fn(async () => ({
      Impl: class {
        query = vi.fn();
      },
    }));
    lazySearchImpl(load);
    expect(load).not.toHaveBeenCalled();
  });

  it('imports once under concurrent query and then delegates', async () => {
    const query = vi.fn(async () => ({ results: [] }));
    const load = vi.fn(async () => ({
      Impl: class {
        query = query;
      },
    }));
    const impl = lazySearchImpl(load);

    await Promise.all([impl.query('a'), impl.query('b')]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('exposes the Search1API auto-engine flag without loading', () => {
    const load = vi.fn(async () => ({
      Impl: class {
        query = vi.fn();
      },
    }));
    const impl = lazySearchImpl(load, { useAutoSearchEngineSelection: true });
    expect(impl.useAutoSearchEngineSelection).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('createSearchServiceImpl mapping', () => {
  it('maps unknown types to Search1API auto-engine selection', () => {
    const impl = createSearchServiceImpl('not-a-provider' as SearchImplType);
    expect(impl.useAutoSearchEngineSelection).toBe(true);
  });

  it('does not set auto-engine on the default SearXNG provider', () => {
    const impl = createSearchServiceImpl();
    expect(impl.useAutoSearchEngineSelection).toBeUndefined();
  });

  it('maps Brave by name without evaluating the provider module at factory time', () => {
    const impl = createSearchServiceImpl(SearchImplType.Brave);
    expect(impl.query).toBeTypeOf('function');
    expect(impl.useAutoSearchEngineSelection).toBeUndefined();
  });
});

import { runWithBoundFetch } from '@lobechat/model-runtime';
import { describe, expect, it } from 'vitest';

import {
  getCurrentEgressScope,
  runWithEgressScope,
  runWithEgressScopeSync,
  wrapRuntimeWithEgressScope,
} from './scope';

describe('wrapRuntimeWithEgressScope', () => {
  it('invokes function properties inside the egress scope and leaves data alone', async () => {
    const seen: string[] = [];
    const runtime = {
      flag: true,
      async ping() {
        seen.push(getCurrentEgressScope() ?? 'none');
        return 'pong';
      },
    };

    const wrapped = wrapRuntimeWithEgressScope(runtime, 'feature:mcp');
    expect(wrapped.flag).toBe(true);
    await expect(wrapped.ping()).resolves.toBe('pong');
    expect(seen).toEqual(['feature:mcp']);
  });

  it('preserves `this` as the original target', async () => {
    const runtime = {
      label: 'inner',
      async read(this: { label: string }) {
        return this.label;
      },
    };
    const wrapped = wrapRuntimeWithEgressScope(runtime, 'feature:mcp');
    await expect(wrapped.read()).resolves.toBe('inner');
  });
});

describe('runWithEgressScope', () => {
  it('binds globalThis.fetch for the duration of the callback', async () => {
    let bound = false;
    await runWithEgressScope('feature:web_search', async () => {
      bound = true;
      expect(getCurrentEgressScope()).toBe('feature:web_search');
    });
    expect(bound).toBe(true);
    expect(getCurrentEgressScope()).toBeNull();
  });

  it('runWithEgressScopeSync returns sync values and still sets the scope', () => {
    const value = runWithEgressScopeSync('feature:market', () => {
      expect(getCurrentEgressScope()).toBe('feature:market');
      return 'sync-ok';
    });
    expect(value).toBe('sync-ok');
    expect(getCurrentEgressScope()).toBeNull();
  });

  it('nests with runWithBoundFetch without leaking the scope', async () => {
    const custom = (async () => new Response('ok')) as typeof fetch;
    await runWithBoundFetch(custom, async () => {
      expect(getCurrentEgressScope()).toBeNull();
    });
  });
});

import { describe, expect, it } from 'vitest';

import { clearRemovedModelReferences } from './forceDisableDependents';

const removed = new Map<string, ReadonlySet<string>>([['openai', new Set(['chat'])]]);

describe('clearRemovedModelReferences', () => {
  it('collapses a matching object to empty', () => {
    expect(clearRemovedModelReferences({ model: 'chat', provider: 'openai' }, removed)).toEqual({
      changed: true,
      empty: true,
      value: {},
    });
  });

  it('keeps leftover keys and drops empty nested containers uniformly', () => {
    expect(
      clearRemovedModelReferences(
        {
          items: [
            { model: 'chat', provider: 'openai' },
            { extra: 1, model: 'chat', provider: 'openai' },
          ],
          keep: true,
          nested: { model: 'chat', provider: 'openai' },
        },
        removed,
      ),
    ).toEqual({
      changed: true,
      empty: false,
      value: { items: [{ extra: 1 }], keep: true },
    });
  });

  it('keeps pre-existing empty siblings so the row is updated, not deleted', () => {
    // empty:false + leftover {} / [] → caller updates the policy; it must not delete it.
    expect(
      clearRemovedModelReferences(
        { keep: {}, list: [], ref: { model: 'chat', provider: 'openai' } },
        removed,
      ),
    ).toEqual({
      changed: true,
      empty: false,
      value: { keep: {}, list: [] },
    });
  });

  it('leaves unrelated values unchanged', () => {
    const value = { count: 2, enabled: true, model: 'other', provider: 'openai' };
    expect(clearRemovedModelReferences(value, removed)).toEqual({
      changed: false,
      empty: false,
      value,
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  emptyRedactionAuthorityMemory,
  isRedactionEnvelopeRenderable,
  reduceRedactionAuthority,
} from './redactionAuthority';

const step = (
  sources: Array<string | null | undefined>,
  memory = emptyRedactionAuthorityMemory(),
) => {
  const reduced = reduceRedactionAuthority(memory, sources);
  return reduced;
};

describe('reduceRedactionAuthority', () => {
  it('starts at the observed max and tightens immediately', () => {
    const first = step(['off']);
    expect(first.view.effective).toBe('off');
    expect(first.view.disagreement).toBe(false);

    const tightened = step(['off', 'strict'], first.memory);
    expect(tightened.view.effective).toBe('strict');
    expect(tightened.view.disagreement).toBe(true);
    expect(tightened.view.purgeEpoch).toBe('strict|disagree');
    expect(tightened.view.isEnvelopeRenderable('off')).toBe(false);
    expect(tightened.view.isEnvelopeRenderable('strict')).toBe(true);
  });

  it('keeps effective strict when a stale off is the only source after eviction', () => {
    const seen = step(['off', 'strict']);
    expect(seen.view.effective).toBe('strict');

    const evicted = step([undefined, undefined], seen.memory);
    expect(evicted.view.effective).toBe('strict');
    expect(evicted.view.disagreement).toBe(false);

    const messagesOffFirst = step(['off', undefined], evicted.memory);
    expect(messagesOffFirst.view.effective).toBe('strict');
    expect(messagesOffFirst.view.disagreement).toBe(true);
    expect(messagesOffFirst.view.isEnvelopeRenderable('off')).toBe(false);
  });

  it('loosens only after every previously seen slot agrees on the looser value', () => {
    const strict = step(['strict', 'strict']);
    expect(strict.view.effective).toBe('strict');

    const oneOff = step(['off', undefined], strict.memory);
    expect(oneOff.view.effective).toBe('strict');

    const bothOff = step(['off', 'off'], oneOff.memory);
    expect(bothOff.view.effective).toBe('off');
    expect(bothOff.view.disagreement).toBe(false);
    expect(bothOff.view.purgeEpoch).toBeNull();
  });

  it('flags initial disagreement so the first render can suppress and purge', () => {
    const initial = step(['off', 'strict']);
    expect(initial.view.effective).toBe('strict');
    expect(initial.view.disagreement).toBe(true);
    expect(initial.view.purgeEpoch).toBe('strict|disagree');
    expect(initial.view.isEnvelopeRenderable('off')).toBe(false);
  });

  it('treats unknown profiles as strict', () => {
    const mixed = step(['off', 'loose']);
    expect(mixed.view.effective).toBe('strict');
    expect(mixed.view.isEnvelopeRenderable('off')).toBe(false);
  });
});

describe('isRedactionEnvelopeRenderable', () => {
  it('allows missing envelope profiles and blocks looser ones', () => {
    expect(isRedactionEnvelopeRenderable(undefined, 'strict')).toBe(true);
    expect(isRedactionEnvelopeRenderable('off', 'off')).toBe(true);
    expect(isRedactionEnvelopeRenderable('off', 'strict')).toBe(false);
    expect(isRedactionEnvelopeRenderable('standard', 'strict')).toBe(false);
    expect(isRedactionEnvelopeRenderable('strict', 'strict')).toBe(true);
  });
});

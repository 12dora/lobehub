import { describe, expect, it } from 'vitest';

import {
  emptyRedactionAuthorityMemory,
  emptyRedactionSlots,
  envelopeSlot,
  isRedactionEnvelopeRenderable,
  type RedactionSlots,
  reduceRedactionAuthority,
  selectRenderablePages,
  UNKNOWN_REDACTION_PROFILE,
} from './redactionAuthority';

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345';

const slots = (partial: Partial<RedactionSlots> = {}): RedactionSlots => ({
  ...emptyRedactionSlots(),
  ...partial,
});

const step = (
  partial: Partial<RedactionSlots>,
  memory = emptyRedactionAuthorityMemory(),
  extraObserved: ReadonlyArray<string | undefined> = [],
) => reduceRedactionAuthority(memory, slots(partial), extraObserved);

describe('envelopeSlot', () => {
  it('maps a present envelope with a missing/unknown profile to unknown (strict rank, non-renderable)', () => {
    expect(envelopeSlot(undefined)).toBeUndefined();
    expect(envelopeSlot(null)).toBeUndefined();
    expect(envelopeSlot({ redactionProfile: 'off' })).toBe('off');
    expect(envelopeSlot({ redactionProfile: 'standard' })).toBe('standard');
    expect(envelopeSlot({ redactionProfile: 'strict' })).toBe('strict');
    expect(envelopeSlot({})).toBe(UNKNOWN_REDACTION_PROFILE);
    expect(envelopeSlot({ redactionProfile: null })).toBe(UNKNOWN_REDACTION_PROFILE);
    expect(envelopeSlot({ redactionProfile: 'loose' })).toBe(UNKNOWN_REDACTION_PROFILE);
  });
});

describe('reduceRedactionAuthority', () => {
  it('starts at the observed max and never loosens within a mount', () => {
    const first = step({ messages: 'off' });
    expect(first.view.effective).toBe('off');
    expect(first.view.disagreement).toBe(false);
    expect(first.view.tightenTo).toBeUndefined();

    const tightened = step({ messages: 'off', policy: 'strict' }, first.memory);
    expect(tightened.view.effective).toBe('strict');
    expect(tightened.view.disagreement).toBe(true);
    expect(tightened.view.tightenTo).toBe('strict');
    expect(tightened.view.isEnvelopeRenderable('off')).toBe(false);
    expect(tightened.view.isEnvelopeRenderable('strict')).toBe(true);

    const allOff = step({ messages: 'off', policy: 'off' }, tightened.memory);
    expect(allOff.view.effective).toBe('strict');
    expect(allOff.view.isEnvelopeRenderable('off')).toBe(false);
  });

  it('keeps effective strict when a stale off is the only source after eviction', () => {
    const seen = step({ messages: 'off', list: 'strict' });
    expect(seen.view.effective).toBe('strict');

    const evicted = step({}, seen.memory);
    expect(evicted.view.effective).toBe('strict');
    expect(evicted.view.disagreement).toBe(false);

    const messagesOffFirst = step({ messages: 'off' }, evicted.memory);
    expect(messagesOffFirst.view.effective).toBe('strict');
    expect(messagesOffFirst.view.disagreement).toBe(true);
    expect(messagesOffFirst.view.isEnvelopeRenderable('off')).toBe(false);
  });

  it('does not loosen after every previously seen slot agrees on a looser value', () => {
    const strict = step({ list: 'strict', policy: 'strict' });
    expect(strict.view.effective).toBe('strict');

    const oneOff = step({ list: 'off', policy: undefined }, strict.memory);
    expect(oneOff.view.effective).toBe('strict');

    const bothOff = step({ list: 'off', policy: 'off' }, oneOff.memory);
    expect(bothOff.view.effective).toBe('strict');
    expect(bothOff.view.isEnvelopeRenderable('off')).toBe(false);
  });

  it('flags initial disagreement so the first render can suppress and purge', () => {
    const initial = step({ messages: 'off', policy: 'strict' });
    expect(initial.view.effective).toBe('strict');
    expect(initial.view.disagreement).toBe(true);
    expect(initial.view.tightenTo).toBe('strict');
    expect(initial.view.isEnvelopeRenderable('off')).toBe(false);
  });

  it('purges once when a single source tightens unanimously off → strict', () => {
    const off = step({ messages: 'off' });
    expect(off.view.tightenTo).toBeUndefined();

    const strict = step({ messages: 'strict' }, off.memory);
    expect(strict.view.effective).toBe('strict');
    expect(strict.view.disagreement).toBe(false);
    expect(strict.view.tightenTo).toBe('strict');
  });

  it('purges when every present source tightens together', () => {
    const off = step({ list: 'off', policy: 'off' });
    const together = step({ list: 'strict', policy: 'strict' }, off.memory);
    expect(together.view.effective).toBe('strict');
    expect(together.view.disagreement).toBe(false);
    expect(together.view.tightenTo).toBe('strict');
  });

  it('cannot loosen when the policy slot shrinks or goes absent', () => {
    const withPolicy = step({ list: 'strict', policy: 'strict' });
    expect(withPolicy.memory.seen.policy).toBe(true);

    const absent = step({ list: 'strict', policy: undefined }, withPolicy.memory);
    expect(absent.view.effective).toBe('strict');
    expect(absent.memory.seen.policy).toBe(true);
    expect(absent.view.tightenTo).toBeUndefined();

    const offWithoutPolicy = step({ list: 'off', policy: undefined }, absent.memory);
    expect(offWithoutPolicy.view.effective).toBe('strict');
    expect(offWithoutPolicy.view.isEnvelopeRenderable('off')).toBe(false);
  });

  it('treats unknown profiles as strict and never renderable', () => {
    const mixed = step({ messages: 'off', policy: UNKNOWN_REDACTION_PROFILE });
    expect(mixed.view.effective).toBe('strict');
    expect(mixed.view.isEnvelopeRenderable('off')).toBe(false);
    expect(mixed.view.isEnvelopeRenderable(UNKNOWN_REDACTION_PROFILE)).toBe(false);
    expect(mixed.view.isEnvelopeRenderable('strict')).toBe(true);
  });

  it('counts extraObserved page profiles in the max and disagreement', () => {
    const first = step({ messages: 'strict' }, emptyRedactionAuthorityMemory(), ['off']);
    expect(first.view.effective).toBe('strict');
    expect(first.view.disagreement).toBe(true);
    expect(first.view.tightenTo).toBe('strict');
    expect(first.view.isEnvelopeRenderable('off')).toBe(false);
  });

  it('never truncates seen-history when a named slot goes in-flight', () => {
    const seen = step({ list: 'off', timeline: 'strict', policy: 'strict' });
    expect(seen.memory.seen).toEqual({
      detail: false,
      list: true,
      messages: false,
      policy: true,
      timeline: true,
    });

    const inflight = step({ list: undefined, timeline: 'strict', policy: undefined }, seen.memory);
    expect(inflight.memory.seen.list).toBe(true);
    expect(inflight.memory.seen.policy).toBe(true);
    expect(inflight.memory.seen.timeline).toBe(true);
    expect(inflight.view.effective).toBe('strict');
  });
});

describe('isRedactionEnvelopeRenderable', () => {
  it('never renders a missing or unknown profile', () => {
    expect(isRedactionEnvelopeRenderable(undefined, 'strict')).toBe(false);
    expect(isRedactionEnvelopeRenderable(undefined, 'off')).toBe(false);
    expect(isRedactionEnvelopeRenderable(UNKNOWN_REDACTION_PROFILE, 'strict')).toBe(false);
    expect(isRedactionEnvelopeRenderable('loose', 'off')).toBe(false);
    expect(isRedactionEnvelopeRenderable('off', 'off')).toBe(true);
    expect(isRedactionEnvelopeRenderable('off', 'strict')).toBe(false);
    expect(isRedactionEnvelopeRenderable('standard', 'strict')).toBe(false);
    expect(isRedactionEnvelopeRenderable('strict', 'strict')).toBe(true);
  });
});

describe('selectRenderablePages', () => {
  it('drops looser pages before flatten so they never merge', () => {
    const pages = [
      { items: [{ id: 'old', body: SECRET }], redactionProfile: 'off' as const },
      { items: [{ id: 'head', body: '[REDACTED]' }], redactionProfile: 'strict' as const },
    ];
    const picked = selectRenderablePages(pages, (profile) =>
      isRedactionEnvelopeRenderable(profile, 'strict'),
    );
    expect(picked).toEqual([{ id: 'head', body: '[REDACTED]' }]);
  });
});

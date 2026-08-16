import { describe, expect, it } from 'vitest';

import { assessRegexSafety, probeRegexPerformance } from './regexSafety';

describe('assessRegexSafety', () => {
  it('rejects nested quantifiers and quantified back-references', () => {
    expect(assessRegexSafety('(a+)+$').ok).toBe(false);
    expect(assessRegexSafety('(\\w*)*x').ok).toBe(false);
    expect(assessRegexSafety('(a*)+').ok).toBe(false);
    expect(assessRegexSafety('\\1+').ok).toBe(false);
  });

  it('rejects lookbehind with a quantifier and accepts a plain lookbehind', () => {
    expect(assessRegexSafety('(?<=a+)b').ok).toBe(false);
    expect(assessRegexSafety('(?<=abc)x').ok).toBe(true);
  });

  it('rejects a quantified group whose body has alternation, wildcard, class escape, or a class', () => {
    expect(assessRegexSafety('(a|a)*')).toEqual({
      ok: false,
      reason: 'unsafe_quantified_group',
    });
    expect(assessRegexSafety('(.*a){20}')).toEqual({
      ok: false,
      reason: 'unsafe_quantified_group',
    });
    expect(assessRegexSafety('(\\w+\\s?)+')).toEqual({
      ok: false,
      reason: 'unsafe_quantified_group',
    });
    expect(assessRegexSafety('([ab])+').ok).toBe(false);
    expect(assessRegexSafety('(\\d)+').ok).toBe(false);
    expect(assessRegexSafety('(ab?c)+').ok).toBe(false);
  });

  it('rejects wrapped variants that only add unquantified groups', () => {
    expect(assessRegexSafety('((a|a)*)').ok).toBe(false);
    expect(assessRegexSafety('((.*a){20})').ok).toBe(false);
    expect(assessRegexSafety('((\\w+\\s?)+)').ok).toBe(false);
    expect(assessRegexSafety('(\\d+\\d+\\d+$)').ok).toBe(false);
    expect(assessRegexSafety('(a{0,201})').ok).toBe(false);
  });

  it('rejects more than two unbounded quantifiers', () => {
    expect(assessRegexSafety('\\d+\\d+\\d+$')).toEqual({
      ok: false,
      reason: 'too_many_unbounded',
    });
    expect(assessRegexSafety('foo.*bar.*baz').ok).toBe(true);
  });

  it('rejects {n,m} whose upper bound is greater than 200', () => {
    expect(assessRegexSafety('a{0,201}')).toEqual({
      ok: false,
      reason: 'repeat_upper_bound',
    });
    expect(assessRegexSafety('a{0,200}').ok).toBe(true);
    expect(assessRegexSafety('a{201}').ok).toBe(true);
  });

  it('accepts a quantified group whose body is a plain literal', () => {
    expect(assessRegexSafety('(abc)+').ok).toBe(true);
    expect(assessRegexSafety('(?:abc)?').ok).toBe(true);
  });

  it('accepts a safe pattern', () => {
    expect(assessRegexSafety('caf[eé]').ok).toBe(true);
    expect(assessRegexSafety('foo|bar').ok).toBe(true);
    expect(assessRegexSafety('1[3-9]\\d{9}').ok).toBe(true);
  });
});

describe('probeRegexPerformance', () => {
  it('accepts a cheap pattern against the three 4000-char probes', () => {
    expect(probeRegexPerformance('caf[eé]').ok).toBe(true);
    expect(probeRegexPerformance('foo.*bar.*baz').ok).toBe(true);
  });

  it('rejects when any probe sample exceeds the budget on both attempts', () => {
    let clock = 0;
    expect(
      probeRegexPerformance('foo', {
        now: () => {
          clock += 60;
          return clock;
        },
      }),
    ).toEqual({ ok: false, reason: 'slow_probe' });
  });

  it('rejects a pattern that does not compile', () => {
    expect(probeRegexPerformance('(unclosed')).toEqual({ ok: false, reason: 'invalid' });
  });
});

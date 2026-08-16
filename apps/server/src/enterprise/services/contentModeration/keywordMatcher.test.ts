import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KeywordRule } from '@/types/platform/contentModeration';
import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import { compileKeywordMatcher, resetKeywordMatcherFuseForTest } from './keywordMatcher';
import * as regexWorker from './regexWorker';

const rule = (
  overrides: Partial<KeywordRule> & Pick<KeywordRule, 'id' | 'pattern'>,
): KeywordRule => ({
  action: 'log',
  category: 'other',
  enabled: true,
  isRegex: false,
  ...overrides,
});

afterEach(() => {
  resetKeywordMatcherFuseForTest();
  vi.restoreAllMocks();
});

describe('compileKeywordMatcher', () => {
  it('picks the strictest action across all matches, not the first hit', () => {
    const matcher = compileKeywordMatcher([
      rule({
        action: 'log',
        category: 'other',
        id: '11111111-1111-4111-8111-111111111111',
        pattern: 'foo',
      }),
      rule({
        action: 'block',
        category: 'sexual',
        id: '22222222-2222-4222-8222-222222222222',
        pattern: 'bar',
      }),
    ]);
    const hit = matcher.matchLiterals('foo and bar');
    expect(hit?.rule.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(hit?.rule.action).toBe('block');
  });

  it('chunks more than 500 literal rules without throwing', () => {
    const rules = Array.from({ length: 520 }, (_, index) =>
      rule({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        pattern: `zzzw${index}`,
      }),
    );
    const matcher = compileKeywordMatcher(rules);
    expect(matcher.matchLiterals('zzzw519')?.rule.pattern).toBe('zzzw519');
    expect(matcher.matchLiterals('nope')).toBeNull();
  });

  it('skips invalid regex at runtime instead of throwing', async () => {
    const matcher = compileKeywordMatcher([
      rule({
        id: '33333333-3333-4333-8333-333333333333',
        isRegex: true,
        pattern: '(unclosed',
      }),
      rule({ id: '44444444-4444-4444-8444-444444444444', pattern: 'ok' }),
    ]);
    await expect(matcher.matchAsync('ok word')).resolves.toMatchObject({
      rule: { pattern: 'ok' },
    });
  });

  it('skips disabled rules', () => {
    const matcher = compileKeywordMatcher([
      rule({
        enabled: false,
        id: '55555555-5555-4555-8555-555555555555',
        pattern: 'hidden',
      }),
    ]);
    expect(matcher.matchLiterals('hidden')).toBeNull();
  });

  it('ranks by effective action: sexual/log + sexual:block beats jailbreak/downgrade', () => {
    const categories = createDefaultContentModerationConfig().categories;
    expect(categories.sexual.action).toBe('block');
    const matcher = compileKeywordMatcher([
      rule({
        action: 'log',
        category: 'sexual',
        id: '11111111-1111-4111-8111-111111111111',
        pattern: 'porn',
      }),
      rule({
        action: 'downgrade',
        category: 'jailbreak',
        id: '22222222-2222-4222-8222-222222222222',
        pattern: 'jail',
      }),
    ]);
    const hit = matcher.matchLiterals('porn and jail', categories);
    expect(hit?.rule.category).toBe('sexual');
    expect(hit?.rule.action).toBe('log');
  });

  it('skips unsafe nested-quantifier regexes at runtime', async () => {
    const matcher = compileKeywordMatcher([
      rule({
        id: '77777777-7777-4777-8777-777777777777',
        isRegex: true,
        pattern: '(a+)+$',
      }),
      rule({ id: '88888888-8888-4888-8888-888888888888', pattern: 'safehit' }),
    ]);
    expect(await matcher.matchAsync('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab')).toBeNull();
    expect((await matcher.matchAsync('safehit'))?.rule.pattern).toBe('safehit');
  });

  it('fuses the rules digest for 60s after a worker timeout and re-arms on a new digest', async () => {
    const spy = vi.spyOn(regexWorker, 'matchRegexRules').mockResolvedValue({ timedOut: true });
    const first = compileKeywordMatcher([
      rule({
        id: '77777777-7777-4777-8777-777777777777',
        isRegex: true,
        pattern: 'alpha',
      }),
    ]);
    expect(await first.matchAsync('alpha')).toBeNull();
    expect(await first.matchAsync('alpha')).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();

    const second = compileKeywordMatcher([
      rule({
        id: '77777777-7777-4777-8777-777777777777',
        isRegex: true,
        pattern: 'beta',
      }),
    ]);
    expect((await second.matchAsync('beta'))?.rule.pattern).toBe('beta');
  });

  it('matches case-insensitively including unicode', async () => {
    const matcher = compileKeywordMatcher([
      rule({ id: '66666666-6666-4666-8666-666666666666', isRegex: true, pattern: 'café' }),
    ]);
    expect((await matcher.matchAsync('CAFÉ'))?.rule.pattern).toBe('café');
  });
});

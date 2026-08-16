import { afterEach, describe, expect, it } from 'vitest';

import {
  getRegexWorkerForTest,
  matchRegexRules,
  probeRegexPattern,
  REGEX_WORKER_MAX_IN_FLIGHT,
  resetRegexWorkerForTest,
  validateKeywordRegex,
} from './regexWorker';

afterEach(async () => {
  await resetRegexWorkerForTest();
});

describe('regexWorker', () => {
  it('matches a normal pattern without blocking', async () => {
    const result = await matchRegexRules({
      digest: 'cafe',
      rules: [{ id: 'r1', pattern: 'café' }],
      text: 'un CAFÉ s’il vous plaît',
    });
    expect(result).toEqual({ matchedRuleIds: ['r1'] });
  });

  it('does not treat a later window start as ^', async () => {
    const text = `${'x'.repeat(3936)}blocked`;
    const result = await matchRegexRules({
      digest: 'caret',
      rules: [{ id: 'r', pattern: '^blocked' }],
      text,
    });
    expect(result).toEqual({ matchedRuleIds: [] });
  });

  it('matches a 200-char sequence that used to straddle the 4000/64 window', async () => {
    const text = `${'x'.repeat(3900)}${'a'.repeat(100)}${'b'.repeat(100)}`;
    const result = await matchRegexRules({
      digest: 'span',
      rules: [{ id: 'r', pattern: 'a{100}b{100}' }],
      text,
    });
    expect(result).toEqual({ matchedRuleIds: ['r'] });
  });

  it('resolves a catastrophic pattern within the timeout and keeps the event loop free', async () => {
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);

    const started = Date.now();
    const result = await matchRegexRules({
      digest: 'catastrophic',
      rules: [{ id: 'bad', pattern: '(a+)+$' }],
      text: `${'a'.repeat(30)}!`,
      timeoutMs: 50,
    });
    const elapsed = Date.now() - started;
    clearInterval(ticker);

    expect(result).toEqual({ timedOut: true });
    expect(elapsed).toBeLessThan(400);
    expect(ticks).toBeGreaterThan(0);
  });

  it('returns timedOut immediately when 32 jobs are already in flight', async () => {
    const hanging = Array.from({ length: REGEX_WORKER_MAX_IN_FLIGHT }, (_, index) =>
      matchRegexRules({
        digest: `slow-${index}`,
        rules: [{ id: 'bad', pattern: '(a+)+$' }],
        text: `${'a'.repeat(30)}!`,
        timeoutMs: 200,
      }),
    );

    const started = Date.now();
    const overflow = await matchRegexRules({
      digest: 'overflow',
      rules: [{ id: 'ok', pattern: 'foo' }],
      text: 'foo',
      timeoutMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(30);
    expect(overflow).toEqual({ timedOut: true });

    await Promise.all(hanging);
  });

  it('keeps a replacement worker alive when a replaced worker later exits', async () => {
    await matchRegexRules({
      digest: 'first',
      rules: [{ id: 'a', pattern: 'ok' }],
      text: 'ok',
    });
    const original = getRegexWorkerForTest();
    expect(original).toBeTruthy();

    original!.emit('error', new Error('boom'));
    expect(getRegexWorkerForTest()).toBeNull();

    const pending = matchRegexRules({
      digest: 'second',
      rules: [{ id: 'b', pattern: 'ok' }],
      text: 'ok',
    });
    const replacement = getRegexWorkerForTest();
    expect(replacement).toBeTruthy();
    expect(replacement).not.toBe(original);

    original!.emit('exit', 1);
    expect(getRegexWorkerForTest()).toBe(replacement);
    await expect(pending).resolves.toEqual({ matchedRuleIds: ['b'] });
  });

  it('probes a cheap pattern as ok and a catastrophic one as slow', async () => {
    await expect(probeRegexPattern('foo.*bar')).resolves.toEqual({ ok: true });
    const slow = await probeRegexPattern('a+a+$', { timeoutMs: 80 });
    expect(slow.ok).toBe(false);
    expect(slow.ok === false && slow.reason).toBe('slow_probe');
  });

  it('validateKeywordRegex fails closed on static unsafety without waiting for the worker', async () => {
    await expect(validateKeywordRegex('((a|a)*)')).resolves.toMatchObject({ ok: false });
    await expect(validateKeywordRegex('foo.*bar.*baz')).resolves.toEqual({ ok: true });
  });
});

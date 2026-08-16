import { afterEach, describe, expect, it } from 'vitest';

import {
  matchRegexRules,
  probeRegexPattern,
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

import { APIError } from 'better-auth/api';
import { describe, expect, it, vi } from 'vitest';

import {
  consumeTwoFactorAttempt,
  createMemoryAtomicIncrement,
  enforceTwoFactorAttemptLimit,
  TWO_FACTOR_ATTEMPT_LIMIT_PATHS,
  TWO_FACTOR_MAX_ATTEMPTS,
  TWO_FACTOR_TOO_MANY_ATTEMPTS_CODE,
  twoFactorAttemptLimit,
} from './attempt-limit';

describe('consumeTwoFactorAttempt', () => {
  it('evaluates at most MAX of N parallel verifies against one challenge', async () => {
    const { increment } = createMemoryAtomicIncrement();
    const invalidate = vi.fn(async () => undefined);
    const evaluated: number[] = [];

    const results = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const result = await consumeTwoFactorAttempt({
          challengeId: 'challenge-1',
          increment,
          invalidate,
        });
        if (result.allowed) evaluated.push(result.count);
        return result;
      }),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(TWO_FACTOR_MAX_ATTEMPTS);
    expect(evaluated).toHaveLength(TWO_FACTOR_MAX_ATTEMPTS);
    expect(invalidate).toHaveBeenCalled();
    expect(invalidate.mock.calls.length).toBe(50 - TWO_FACTOR_MAX_ATTEMPTS);
  });

  it('does not punish a user who fumbles a code twice', async () => {
    const { increment } = createMemoryAtomicIncrement();
    const invalidate = vi.fn(async () => undefined);

    const first = await consumeTwoFactorAttempt({
      challengeId: 'challenge-2',
      increment,
      invalidate,
    });
    const second = await consumeTwoFactorAttempt({
      challengeId: 'challenge-2',
      increment,
      invalidate,
    });

    expect(first).toEqual({ allowed: true, count: 1 });
    expect(second).toEqual({ allowed: true, count: 2 });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('evicts expired keys and deletes on consume so the map cannot grow without bound', async () => {
    const memory = createMemoryAtomicIncrement();
    await memory.increment('2fa-attempts:old', 0);
    await memory.increment('2fa-attempts:live', 600);
    expect(memory.size()).toBe(1);
    await memory.delete('2fa-attempts:live');
    expect(memory.size()).toBe(0);
  });

  it('isolates counters per challenge', async () => {
    const { increment } = createMemoryAtomicIncrement();
    const invalidate = vi.fn(async () => undefined);

    for (let i = 0; i < TWO_FACTOR_MAX_ATTEMPTS; i += 1) {
      await consumeTwoFactorAttempt({ challengeId: 'a', increment, invalidate });
    }
    const other = await consumeTwoFactorAttempt({
      challengeId: 'b',
      increment,
      invalidate,
    });

    expect(other.allowed).toBe(true);
    expect(other.count).toBe(1);
  });
});

describe('enforceTwoFactorAttemptLimit', () => {
  it('covers the guessable second-factor endpoints', () => {
    expect([...TWO_FACTOR_ATTEMPT_LIMIT_PATHS]).toEqual([
      '/two-factor/verify-totp',
      '/two-factor/verify-backup-code',
    ]);
  });

  it('registers a before-hook on those paths', () => {
    const plugin = twoFactorAttemptLimit();
    const hook = plugin.hooks?.before?.[0];
    if (!hook) throw new Error('missing before hook');

    expect(hook.matcher({ path: '/two-factor/verify-totp' } as never)).toBe(true);
    expect(hook.matcher({ path: '/two-factor/verify-backup-code' } as never)).toBe(true);
    expect(hook.matcher({ path: '/sign-in/email' } as never)).toBe(false);
  });

  it('rejects over-limit verifies and invalidates the challenge', async () => {
    const { increment } = createMemoryAtomicIncrement();
    const invalidate = vi.fn(async () => undefined);

    await enforceTwoFactorAttemptLimit({
      challengeId: '2fa-challenge',
      increment,
      invalidate,
      maxAttempts: 2,
    });
    await enforceTwoFactorAttemptLimit({
      challengeId: '2fa-challenge',
      increment,
      invalidate,
      maxAttempts: 2,
    });

    try {
      await enforceTwoFactorAttemptLimit({
        challengeId: '2fa-challenge',
        increment,
        invalidate,
        maxAttempts: 2,
      });
      expect.unreachable('expected too-many-attempts');
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as InstanceType<typeof APIError>).body?.code).toBe(
        TWO_FACTOR_TOO_MANY_ATTEMPTS_CODE,
      );
    }

    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('skips the counter when there is no challenge cookie', async () => {
    const increment = vi.fn(async () => 1);
    await enforceTwoFactorAttemptLimit({
      challengeId: null,
      increment,
      invalidate: vi.fn(async () => undefined),
    });
    expect(increment).not.toHaveBeenCalled();
  });
});

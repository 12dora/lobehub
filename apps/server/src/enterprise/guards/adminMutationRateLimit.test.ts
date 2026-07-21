// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';
import { authedProcedure, createCallerFactory, router } from '@/libs/trpc/lambda';

import {
  InMemoryAdminMutationRateLimiter,
  resetSharedAdminMutationRateLimiter,
  setSharedAdminMutationRateLimiter,
} from '../security/rateLimit/adminMutationRateLimiter';
import {
  getAdminMutationRateLimitMetadata,
  withAdminMutationRateLimit,
} from './adminMutationRateLimit';
import { getEnterpriseErrorBody } from './enterpriseErrors';

const createCaller = createCallerFactory(
  router({
    mutate: authedProcedure.use(withAdminMutationRateLimit()).mutation(async () => ({ ok: true })),
    read: authedProcedure.use(withAdminMutationRateLimit()).query(async () => ({ ok: true })),
  }),
);

describe('withAdminMutationRateLimit (unit, scoped in-memory double)', () => {
  beforeEach(() => {
    setSharedAdminMutationRateLimiter(
      new InMemoryAdminMutationRateLimiter({
        config: { limit: 2, windowMs: 60_000 },
      }),
    );
  });

  afterEach(() => {
    // Restore production singleton selection — never leave a double installed.
    resetSharedAdminMutationRateLimiter();
  });

  it('allows mutations below the boundary and denies above without business work', async () => {
    const business = vi.fn(async () => ({ done: true }));
    const limitedRouter = router({
      mutate: authedProcedure.use(withAdminMutationRateLimit()).mutation(async () => business()),
    });
    const limitedCaller = createCallerFactory(limitedRouter);
    const caller = limitedCaller({ userId: 'actor-1' } as never);

    await expect(caller.mutate()).resolves.toEqual({ done: true });
    await expect(caller.mutate()).resolves.toEqual({ done: true });
    await expect(caller.mutate()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(business).toHaveBeenCalledTimes(2);

    try {
      await caller.mutate();
    } catch (error) {
      expect(getEnterpriseErrorBody(error)).toMatchObject({
        code: ADMIN_ERROR_CODES.ADMIN_RATE_LIMITED,
      });
    }
  });

  it('does not consume quota for queries', async () => {
    const caller = createCaller({ userId: 'actor-1' } as never);
    await expect(caller.read()).resolves.toEqual({ ok: true });
    await expect(caller.read()).resolves.toEqual({ ok: true });
    await expect(caller.read()).resolves.toEqual({ ok: true });
    await expect(caller.mutate()).resolves.toEqual({ ok: true });
    await expect(caller.mutate()).resolves.toEqual({ ok: true });
    await expect(caller.mutate()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('isolates actors and procedures', async () => {
    const limitedRouter = router({
      alpha: authedProcedure.use(withAdminMutationRateLimit()).mutation(async () => 'a'),
      beta: authedProcedure.use(withAdminMutationRateLimit()).mutation(async () => 'b'),
    });
    const makeCaller = createCallerFactory(limitedRouter);
    const actorA = makeCaller({ userId: 'actor-a' } as never);
    const actorB = makeCaller({ userId: 'actor-b' } as never);

    await expect(actorA.alpha()).resolves.toBe('a');
    await expect(actorA.alpha()).resolves.toBe('a');
    await expect(actorA.alpha()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await expect(actorB.alpha()).resolves.toBe('a');
    await expect(actorA.beta()).resolves.toBe('b');
  });

  it('fails closed when the shared backend is unavailable', async () => {
    setSharedAdminMutationRateLimiter({
      consume: async () => 'unavailable',
    });
    const caller = createCaller({ userId: 'actor-1' } as never);
    await expect(caller.mutate()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: ADMIN_ERROR_CODES.ADMIN_RATE_LIMITED,
    });
  });

  it('keeps middleware metadata private and immutable', () => {
    const procedure = authedProcedure.use(withAdminMutationRateLimit()).mutation(() => null);
    const metadata = getAdminMutationRateLimitMetadata(procedure);
    expect(metadata).toEqual([{ enforced: true, kind: 'admin-mutation-rate-limit' }]);
    expect(Object.isFrozen(metadata[0])).toBe(true);
  });
});

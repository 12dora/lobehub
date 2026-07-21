// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';
import { getTestDB } from '@/database/core/getTestDB';
import { platformAdminMutationRateWindows } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, createCallerFactory, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  resetSharedAdminMutationRateLimiter,
  setSharedAdminMutationRateLimiter,
  SharedAdminMutationRateLimiter,
} from '../security/rateLimit/adminMutationRateLimiter';
import { withAdminMutationRateLimit } from './adminMutationRateLimit';
import { getEnterpriseErrorBody } from './enterpriseErrors';

const db: LobeChatDatabase = await getTestDB();

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

/**
 * Production-wiring integration: no Redis, PostgreSQL fallback via serverDatabase.
 * Does not install a process-local Map double as the production singleton default.
 */
describe('withAdminMutationRateLimit production wiring (PostgreSQL fallback)', () => {
  beforeEach(async () => {
    await db.delete(platformAdminMutationRateWindows);
    resetSharedAdminMutationRateLimiter();
    setSharedAdminMutationRateLimiter(
      new SharedAdminMutationRateLimiter({
        config: { limit: 2, windowMs: 60_000 },
        redis: { tryConsume: async () => 'unavailable' } as never,
      }),
    );
  });

  afterEach(async () => {
    await db.delete(platformAdminMutationRateWindows);
    resetSharedAdminMutationRateLimiter();
  });

  const buildRouter = () => {
    const business = vi.fn(async () => ({ done: true }));
    const app = router({
      mutate: authedProcedure
        .use(serverDatabase)
        .use(withAdminMutationRateLimit())
        .mutation(async () => business()),
      read: authedProcedure
        .use(serverDatabase)
        .use(withAdminMutationRateLimit())
        .query(async () => ({ ok: true })),
    });
    return { business, createCaller: createCallerFactory(app) };
  };

  it('allows mutations below the limit through PostgreSQL and denies at the boundary with zero business work', async () => {
    const { business, createCaller } = buildRouter();
    const caller = createCaller({ userId: 'actor-pg-1' } as never);

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

  it('does not consume quota for queries on the same base middleware', async () => {
    const { business, createCaller } = buildRouter();
    const caller = createCaller({ userId: 'actor-pg-2' } as never);

    await expect(caller.read()).resolves.toEqual({ ok: true });
    await expect(caller.read()).resolves.toEqual({ ok: true });
    await expect(caller.read()).resolves.toEqual({ ok: true });
    await expect(caller.mutate()).resolves.toEqual({ done: true });
    await expect(caller.mutate()).resolves.toEqual({ done: true });
    await expect(caller.mutate()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(business).toHaveBeenCalledTimes(2);
  });
});

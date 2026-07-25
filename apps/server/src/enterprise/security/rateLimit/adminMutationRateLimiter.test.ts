// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import {
  getSharedAdminMutationRateLimiter,
  InMemoryAdminMutationRateLimiter,
  PostgresAdminMutationRateLimiter,
  resetSharedAdminMutationRateLimiter,
  resolveAdminMutationRateLimitConfig,
} from './adminMutationRateLimiter';

describe('resolveAdminMutationRateLimitConfig', () => {
  it('uses bounded defaults when env is unset or out of range', () => {
    expect(resolveAdminMutationRateLimitConfig({})).toMatchObject({ limit: 60, windowMs: 60_000 });
    expect(
      resolveAdminMutationRateLimitConfig({
        ADMIN_MUTATION_RATE_LIMIT: '99999',
        ADMIN_MUTATION_RATE_WINDOW_MS: '10',
      }),
    ).toMatchObject({ limit: 60, windowMs: 60_000 });
    expect(
      resolveAdminMutationRateLimitConfig({
        ADMIN_MUTATION_RATE_LIMIT: '12',
        ADMIN_MUTATION_RATE_WINDOW_MS: '5000',
      }),
    ).toMatchObject({ limit: 12, windowMs: 5000 });
  });
});

describe('PostgresAdminMutationRateLimiter', () => {
  afterEach(() => {
    resetSharedAdminMutationRateLimiter();
  });

  it('returns unavailable without a database', async () => {
    await expect(
      new PostgresAdminMutationRateLimiter({
        config: {
          ...resolveAdminMutationRateLimitConfig({}),
          limit: 2,
          windowMs: 60_000,
        },
      }).consume({ actorId: 'a', procedure: 'admin.x' }),
    ).resolves.toBe('unavailable');
  });

  it('getSharedAdminMutationRateLimiter constructs PostgresAdminMutationRateLimiter', () => {
    resetSharedAdminMutationRateLimiter();
    expect(getSharedAdminMutationRateLimiter()).toBeInstanceOf(PostgresAdminMutationRateLimiter);
    resetSharedAdminMutationRateLimiter();
  });
});

describe('InMemoryAdminMutationRateLimiter', () => {
  it('is a unit-test double with independent scopes and boundary behavior', async () => {
    const store = new Map<string, { count: number; resetAt: number }>();
    const limiter = new InMemoryAdminMutationRateLimiter({
      config: { limit: 2, windowMs: 60_000 },
      now: () => 1_000,
      store,
    });
    await expect(
      limiter.consume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      limiter.consume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      limiter.consume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('limited');
    await expect(
      limiter.consume({ actorId: 'user-b', procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
  });
});

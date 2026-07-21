// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_MUTATION_RATE_REDIS_RELATIVE_PREFIX,
  adminMutationRateLimitRelativeRedisKey,
  digestAdminMutationRateScope,
  InMemoryAdminMutationRateLimiter,
  PostgresAdminMutationRateLimiter,
  RedisAdminMutationRateLimiter,
  resetSharedAdminMutationRateLimiter,
  resolveAdminMutationRateLimitConfig,
  SharedAdminMutationRateLimiter,
} from './adminMutationRateLimiter';

describe('resolveAdminMutationRateLimitConfig', () => {
  it('uses bounded defaults when env is unset or out of range', () => {
    expect(resolveAdminMutationRateLimitConfig({})).toEqual({ limit: 60, windowMs: 60_000 });
    expect(
      resolveAdminMutationRateLimitConfig({
        ADMIN_MUTATION_RATE_LIMIT: '99999',
        ADMIN_MUTATION_RATE_WINDOW_MS: '10',
      }),
    ).toEqual({ limit: 60, windowMs: 60_000 });
    expect(
      resolveAdminMutationRateLimitConfig({
        ADMIN_MUTATION_RATE_LIMIT: '12',
        ADMIN_MUTATION_RATE_WINDOW_MS: '5000',
      }),
    ).toEqual({ limit: 12, windowMs: 5000 });
  });
});

describe('RedisAdminMutationRateLimiter', () => {
  const evalMock = vi.fn();
  const getRedis = vi.fn();

  beforeEach(() => {
    evalMock.mockReset();
    getRedis.mockReset().mockReturnValue({ eval: evalMock });
  });

  const limiter = (config?: { limit: number; windowMs: number }) =>
    new RedisAdminMutationRateLimiter({
      config: config ?? { limit: 60, windowMs: 60_000 },
      getRedis,
    });

  it('fails closed (unavailable) when Redis is absent', async () => {
    getRedis.mockReturnValue(null);
    await expect(
      limiter().tryConsume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('unavailable');
  });

  it('fails closed when Redis eval errors', async () => {
    evalMock.mockRejectedValue(new Error('redis down'));
    await expect(
      limiter().tryConsume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('unavailable');
  });

  it('allows at the boundary and denies above it', async () => {
    evalMock.mockResolvedValueOnce(60).mockResolvedValueOnce(61);
    const instance = limiter({ limit: 60, windowMs: 60_000 });
    await expect(
      instance.tryConsume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      instance.tryConsume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('limited');
  });

  it('digests actor and procedure so raw user ids never appear in Redis keys', async () => {
    evalMock.mockResolvedValue(1);
    await limiter().tryConsume({
      actorId: 'user-secret-id',
      procedure: 'admin.agents.create',
    });
    const key = evalMock.mock.calls[0]?.[2] as string;
    expect(key).toBe(
      adminMutationRateLimitRelativeRedisKey(
        digestAdminMutationRateScope({
          actorId: 'user-secret-id',
          procedure: 'admin.agents.create',
        }),
      ),
    );
    expect(key).not.toContain('user-secret-id');
    expect(key).not.toContain('admin.agents.create');
    expect(key.startsWith(`${ADMIN_MUTATION_RATE_REDIS_RELATIVE_PREFIX}:`)).toBe(true);
  });

  it('isolates deployment prefixes through createRedisWithPrefix', async () => {
    const evalA = vi.fn().mockResolvedValue(1);
    const evalB = vi.fn().mockResolvedValue(1);
    const createRedisWithPrefix = vi.fn(async (_config, prefix: string) => {
      if (prefix === 'deploy-a') return { eval: evalA } as never;
      if (prefix === 'deploy-b') return { eval: evalB } as never;
      return null;
    });

    const left = new RedisAdminMutationRateLimiter({
      config: { limit: 10, windowMs: 60_000 },
      dependencies: {
        createRedisWithPrefix,
        getRedisConfig: () =>
          ({
            enabled: true,
            prefix: 'deploy-a',
            tls: false,
            url: 'redis://example',
          }) as never,
      },
    });
    const right = new RedisAdminMutationRateLimiter({
      config: { limit: 10, windowMs: 60_000 },
      dependencies: {
        createRedisWithPrefix,
        getRedisConfig: () =>
          ({
            enabled: true,
            prefix: 'deploy-b',
            tls: false,
            url: 'redis://example',
          }) as never,
      },
    });

    await left.tryConsume({ actorId: 'user-a', procedure: 'admin.agents.create' });
    await right.tryConsume({ actorId: 'user-a', procedure: 'admin.agents.create' });

    expect(createRedisWithPrefix).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'deploy-a' }),
      'deploy-a',
    );
    expect(createRedisWithPrefix).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'deploy-b' }),
      'deploy-b',
    );
    expect(evalA).toHaveBeenCalledOnce();
    expect(evalB).toHaveBeenCalledOnce();
    // Relative keys match; ioredis keyPrefix isolates deployments at the client layer.
    expect(evalA.mock.calls[0]?.[2]).toBe(evalB.mock.calls[0]?.[2]);
  });

  it('shares counters when the same deployment prefix is used', async () => {
    let count = 0;
    const evalShared = vi.fn(async () => {
      count += 1;
      return count;
    });
    const createRedisWithPrefix = vi.fn(async () => ({ eval: evalShared }) as never);
    const config = {
      enabled: true,
      prefix: 'same-deploy',
      tls: false,
      url: 'redis://example',
    } as never;

    const first = new RedisAdminMutationRateLimiter({
      config: { limit: 2, windowMs: 60_000 },
      dependencies: { createRedisWithPrefix, getRedisConfig: () => config },
    });
    const second = new RedisAdminMutationRateLimiter({
      config: { limit: 2, windowMs: 60_000 },
      dependencies: { createRedisWithPrefix, getRedisConfig: () => config },
    });

    await expect(
      first.tryConsume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      second.tryConsume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      first.tryConsume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('limited');
  });
});

describe('SharedAdminMutationRateLimiter composition', () => {
  afterEach(() => {
    resetSharedAdminMutationRateLimiter();
  });

  it('falls through to PostgreSQL when Redis is unavailable', async () => {
    const postgresConsume = vi.fn(async () => 'allowed' as const);
    const composite = new SharedAdminMutationRateLimiter({
      config: { limit: 2, windowMs: 60_000 },
      postgres: { consume: postgresConsume } as never,
      redis: { tryConsume: async () => 'unavailable' } as never,
    });
    await expect(
      composite.consume({ actorId: 'a', db: {} as never, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    expect(postgresConsume).toHaveBeenCalledOnce();
  });

  it('does not fall through when Redis already limited the request', async () => {
    const postgresConsume = vi.fn(async () => 'allowed' as const);
    const composite = new SharedAdminMutationRateLimiter({
      postgres: { consume: postgresConsume } as never,
      redis: { tryConsume: async () => 'limited' } as never,
    });
    await expect(
      composite.consume({ actorId: 'a', db: {} as never, procedure: 'admin.agents.create' }),
    ).resolves.toBe('limited');
    expect(postgresConsume).not.toHaveBeenCalled();
  });

  it('fails closed only when both Redis and PostgreSQL are unavailable', async () => {
    const composite = new SharedAdminMutationRateLimiter({
      postgres: { consume: async () => 'unavailable' } as never,
      redis: { tryConsume: async () => 'unavailable' } as never,
    });
    await expect(
      composite.consume({ actorId: 'a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('unavailable');
  });
});

describe('PostgresAdminMutationRateLimiter', () => {
  it('returns unavailable without a database', async () => {
    await expect(
      new PostgresAdminMutationRateLimiter({
        config: { limit: 2, windowMs: 60_000 },
      }).consume({ actorId: 'a', procedure: 'admin.x' }),
    ).resolves.toBe('unavailable');
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

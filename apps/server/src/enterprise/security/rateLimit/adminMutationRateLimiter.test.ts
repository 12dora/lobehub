// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminMutationRateLimitRedisKey,
  digestAdminMutationRateScope,
  InMemoryAdminMutationRateLimiter,
  resolveAdminMutationRateLimitConfig,
  SharedAdminMutationRateLimiter,
} from './adminMutationRateLimiter';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  getRedis: vi.fn(),
}));

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

describe('SharedAdminMutationRateLimiter', () => {
  beforeEach(() => {
    mocks.eval.mockReset();
    mocks.getRedis.mockReset().mockReturnValue({ eval: mocks.eval });
  });

  const limiter = (config?: { limit: number; windowMs: number }) =>
    new SharedAdminMutationRateLimiter({
      config: config ?? { limit: 60, windowMs: 60_000 },
      getRedis: mocks.getRedis,
    });

  it('fails closed when Redis is absent', async () => {
    mocks.getRedis.mockReturnValue(null);
    await expect(
      limiter().consume({
        actorId: 'user-a',
        procedure: 'admin.agents.create',
      }),
    ).resolves.toBe('unavailable');
  });

  it('fails closed when Redis eval errors', async () => {
    mocks.eval.mockRejectedValue(new Error('redis down'));
    await expect(
      limiter().consume({
        actorId: 'user-a',
        procedure: 'admin.agents.create',
      }),
    ).resolves.toBe('unavailable');
  });

  it('allows at the boundary and denies above it', async () => {
    mocks.eval.mockResolvedValueOnce(60).mockResolvedValueOnce(61);
    const instance = limiter({ limit: 60, windowMs: 60_000 });
    await expect(
      instance.consume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      instance.consume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('limited');
  });

  it('digests actor and procedure so raw user ids never appear in Redis keys', async () => {
    mocks.eval.mockResolvedValue(1);
    await limiter().consume({
      actorId: 'user-secret-id',
      procedure: 'admin.agents.create',
    });
    const key = mocks.eval.mock.calls[0]?.[2] as string;
    expect(key).toBe(
      adminMutationRateLimitRedisKey(
        digestAdminMutationRateScope({
          actorId: 'user-secret-id',
          procedure: 'admin.agents.create',
        }),
      ),
    );
    expect(key).not.toContain('user-secret-id');
    expect(key).not.toContain('admin.agents.create');
    expect(key).toMatch(/^platform:admin-mutation:rate:[a-f\d]{64}$/);
  });

  it('keeps independent actors and procedures on separate counters', async () => {
    mocks.eval.mockResolvedValue(1);
    const instance = limiter({ limit: 1, windowMs: 60_000 });
    await instance.consume({ actorId: 'user-a', procedure: 'admin.agents.create' });
    await instance.consume({ actorId: 'user-b', procedure: 'admin.agents.create' });
    await instance.consume({ actorId: 'user-a', procedure: 'admin.agents.archive' });
    const keys = mocks.eval.mock.calls.map((call) => call[2]);
    expect(new Set(keys).size).toBe(3);
  });

  it('shares Redis state across two limiter instances', async () => {
    let count = 0;
    mocks.eval.mockImplementation(async () => {
      count += 1;
      return count;
    });
    const first = limiter({ limit: 2, windowMs: 60_000 });
    const second = limiter({ limit: 2, windowMs: 60_000 });
    await expect(
      first.consume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      second.consume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      first.consume({ actorId: 'user-a', procedure: 'admin.agents.create' }),
    ).resolves.toBe('limited');
  });
});

describe('InMemoryAdminMutationRateLimiter', () => {
  it('is a test double with independent scopes and boundary behavior', async () => {
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
    await expect(
      limiter.consume({ actorId: 'user-a', procedure: 'admin.agents.archive' }),
    ).resolves.toBe('allowed');
  });
});

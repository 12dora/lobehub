/**
 * Multi-instance atomic rate limiter for enterprise admin mutations.
 *
 * Production path:
 * 1. Redis (deployment-prefixed) when available
 * 2. PostgreSQL atomic fallback when Redis is absent/unavailable/errors
 * 3. Fail closed only when both shared stores fail
 *
 * Process-local Map is a unit-test double only — never production wiring.
 */
import { createHash } from 'node:crypto';

import { PlatformAdminMutationRateModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import { getRedisConfig } from '@/envs/redis';
import type { BaseRedisProvider } from '@/libs/redis';
import { createRedisWithPrefix, isRedisEnabled } from '@/libs/redis/manager';

export const ADMIN_MUTATION_RATE_LIMIT_DEFAULTS = {
  /** Maximum mutations per actor+procedure inside one window. */
  limit: 60,
  /** Absolute upper bound for configured limit (server-side only). */
  maxLimit: 1000,
  /** Absolute upper bound for configured window (1 hour). */
  maxWindowMs: 3_600_000,
  /** Absolute lower bound for configured limit. */
  minLimit: 1,
  /** Absolute lower bound for configured window (1 second). */
  minWindowMs: 1000,
  /** Fixed window length in milliseconds. */
  windowMs: 60_000,
} as const;

/** Relative key under the deployment Redis prefix. */
export const ADMIN_MUTATION_RATE_REDIS_RELATIVE_PREFIX = 'platform:admin-mutation:rate';

const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export type AdminMutationRateLimitDecision = 'allowed' | 'limited' | 'unavailable';

export interface AdminMutationRateLimitConfig {
  limit: number;
  windowMs: number;
}

export interface AdminMutationRateLimitScope {
  actorId: string;
  /**
   * Database used for the PostgreSQL atomic fallback.
   * Required on the production middleware path.
   */
  db?: LobeChatDatabase;
  /** Canonical `admin.*` procedure path. */
  procedure: string;
}

export interface AdminMutationRateLimiter {
  consume: (scope: AdminMutationRateLimitScope) => Promise<AdminMutationRateLimitDecision>;
}

export interface RedisEvalClient {
  eval: (script: string, numkeys: number, ...args: Array<string | number>) => Promise<unknown>;
}

const clampInt = (value: number, min: number, max: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
};

/**
 * Resolve bounded server-side configuration. Client input is never accepted.
 */
export const resolveAdminMutationRateLimitConfig = (
  env: Record<string, string | undefined> = process.env,
): AdminMutationRateLimitConfig => {
  const rawLimit = env.ADMIN_MUTATION_RATE_LIMIT;
  const rawWindow = env.ADMIN_MUTATION_RATE_WINDOW_MS;
  const limit = clampInt(
    rawLimit === undefined || rawLimit === '' ? Number.NaN : Number(rawLimit),
    ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.minLimit,
    ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.maxLimit,
    ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.limit,
  );
  const windowMs = clampInt(
    rawWindow === undefined || rawWindow === '' ? Number.NaN : Number(rawWindow),
    ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.minWindowMs,
    ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.maxWindowMs,
    ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.windowMs,
  );
  return { limit, windowMs };
};

/** Stable digest so raw actor identifiers never appear in Redis keys or PG rows. */
export const digestAdminMutationRateScope = (
  scope: Pick<AdminMutationRateLimitScope, 'actorId' | 'procedure'>,
): string =>
  createHash('sha256').update(`${scope.actorId}\0${scope.procedure}`, 'utf8').digest('hex');

/**
 * Relative Redis key (ioredis keyPrefix supplies the deployment REDIS_PREFIX).
 * Never log the full deployment prefix as a secret/tenant identifier.
 */
export const adminMutationRateLimitRelativeRedisKey = (scopeDigest: string): string =>
  `${ADMIN_MUTATION_RATE_REDIS_RELATIVE_PREFIX}:${scopeDigest}`;

/** @deprecated use adminMutationRateLimitRelativeRedisKey — kept for focused unit tests */
export const adminMutationRateLimitRedisKey = adminMutationRateLimitRelativeRedisKey;

export interface AdminMutationRateRedisDependencies {
  createRedisWithPrefix: (
    config: ReturnType<typeof getRedisConfig>,
    prefix: string,
  ) => Promise<BaseRedisProvider | null>;
  getRedisConfig: () => ReturnType<typeof getRedisConfig>;
}

const defaultRedisDependencies: AdminMutationRateRedisDependencies = {
  createRedisWithPrefix,
  getRedisConfig,
};

/**
 * Redis fast path. Returns `unavailable` when Redis is disabled, init fails, or eval errors.
 * Keys are namespaced under the deployment REDIS_PREFIX via createRedisWithPrefix.
 */
export class RedisAdminMutationRateLimiter {
  private readonly config: AdminMutationRateLimitConfig;
  private readonly dependencies: AdminMutationRateRedisDependencies;
  private clientPromise: Promise<RedisEvalClient | null> | null = null;
  /** Optional inject for deterministic unit tests (already-prefixed client). */
  private readonly getRedisOverride?: () => RedisEvalClient | null;

  constructor(options?: {
    config?: AdminMutationRateLimitConfig;
    dependencies?: Partial<AdminMutationRateRedisDependencies>;
    /** Test-only: bypass async Redis manager with a ready client (or null). */
    getRedis?: () => RedisEvalClient | null;
  }) {
    this.config = options?.config ?? resolveAdminMutationRateLimitConfig();
    this.dependencies = {
      ...defaultRedisDependencies,
      ...options?.dependencies,
    };
    this.getRedisOverride = options?.getRedis;
  }

  private resolveClient = async (): Promise<RedisEvalClient | null> => {
    if (this.getRedisOverride) return this.getRedisOverride();
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        try {
          const config = this.dependencies.getRedisConfig();
          if (!isRedisEnabled(config)) return null;
          // Deployment isolation: ioredis keyPrefix = `${REDIS_PREFIX}:`
          const prefix = config.prefix || 'lobechat';
          const client = await this.dependencies.createRedisWithPrefix(config, prefix);
          return client as RedisEvalClient | null;
        } catch {
          return null;
        }
      })();
    }
    return this.clientPromise;
  };

  /**
   * Attempt Redis consumption. `unavailable` means caller should try PostgreSQL.
   */
  tryConsume = async (
    scope: Pick<AdminMutationRateLimitScope, 'actorId' | 'procedure'>,
  ): Promise<AdminMutationRateLimitDecision> => {
    const redis = await this.resolveClient();
    if (!redis) return 'unavailable';

    const digest = digestAdminMutationRateScope(scope);
    const key = adminMutationRateLimitRelativeRedisKey(digest);
    try {
      const count = await redis.eval(CONSUME_SCRIPT, 1, key, String(this.config.windowMs));
      const numeric = Number(count);
      if (!Number.isFinite(numeric) || numeric <= 0) return 'unavailable';
      return numeric <= this.config.limit ? 'allowed' : 'limited';
    } catch {
      // Force next call to re-resolve when the client becomes unhealthy.
      this.clientPromise = null;
      return 'unavailable';
    }
  };
}

/**
 * PostgreSQL atomic fallback shared across server processes.
 */
export class PostgresAdminMutationRateLimiter {
  private readonly config: AdminMutationRateLimitConfig;

  constructor(options?: { config?: AdminMutationRateLimitConfig }) {
    this.config = options?.config ?? resolveAdminMutationRateLimitConfig();
  }

  consume = async (scope: AdminMutationRateLimitScope): Promise<AdminMutationRateLimitDecision> => {
    if (!scope.db) return 'unavailable';
    try {
      const digest = digestAdminMutationRateScope(scope);
      const result = await new PlatformAdminMutationRateModel(scope.db).consume({
        limit: this.config.limit,
        scopeDigest: digest,
        windowMs: this.config.windowMs,
      });
      return result.allowed ? 'allowed' : 'limited';
    } catch {
      return 'unavailable';
    }
  };
}

/**
 * Production composite: Redis first, PostgreSQL fallback, fail closed only if both fail.
 */
export class SharedAdminMutationRateLimiter implements AdminMutationRateLimiter {
  private readonly redis: RedisAdminMutationRateLimiter;
  private readonly postgres: PostgresAdminMutationRateLimiter;

  constructor(options?: {
    config?: AdminMutationRateLimitConfig;
    postgres?: PostgresAdminMutationRateLimiter;
    redis?: RedisAdminMutationRateLimiter;
  }) {
    const config = options?.config ?? resolveAdminMutationRateLimitConfig();
    this.redis = options?.redis ?? new RedisAdminMutationRateLimiter({ config });
    this.postgres = options?.postgres ?? new PostgresAdminMutationRateLimiter({ config });
  }

  consume = async (scope: AdminMutationRateLimitScope): Promise<AdminMutationRateLimitDecision> => {
    const redisDecision = await this.redis.tryConsume(scope);
    if (redisDecision === 'allowed' || redisDecision === 'limited') {
      return redisDecision;
    }
    return this.postgres.consume(scope);
  };
}

/**
 * Process-local test double only. Never used as the production enforcement path.
 */
export class InMemoryAdminMutationRateLimiter implements AdminMutationRateLimiter {
  private readonly config: AdminMutationRateLimitConfig;
  private readonly store: Map<string, { count: number; resetAt: number }>;
  private readonly now: () => number;

  constructor(options?: {
    config?: AdminMutationRateLimitConfig;
    now?: () => number;
    store?: Map<string, { count: number; resetAt: number }>;
  }) {
    this.config = options?.config ?? {
      limit: ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.limit,
      windowMs: ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.windowMs,
    };
    this.store = options?.store ?? new Map();
    this.now = options?.now ?? Date.now;
  }

  consume = async (scope: AdminMutationRateLimitScope): Promise<AdminMutationRateLimitDecision> => {
    const digest = digestAdminMutationRateScope(scope);
    const now = this.now();
    const existing = this.store.get(digest);
    if (!existing || existing.resetAt <= now) {
      this.store.set(digest, { count: 1, resetAt: now + this.config.windowMs });
      return 'allowed';
    }
    existing.count += 1;
    return existing.count <= this.config.limit ? 'allowed' : 'limited';
  };
}

let sharedLimiter: AdminMutationRateLimiter | null = null;

/**
 * Production singleton — always SharedAdminMutationRateLimiter (Redis → PostgreSQL).
 * Unit tests may inject a double via setSharedAdminMutationRateLimiter for isolation;
 * router/integration suites must not replace this globally.
 */
export const getSharedAdminMutationRateLimiter = (): AdminMutationRateLimiter => {
  if (!sharedLimiter) {
    sharedLimiter = new SharedAdminMutationRateLimiter();
  }
  return sharedLimiter;
};

export const setSharedAdminMutationRateLimiter = (
  limiter: AdminMutationRateLimiter | null,
): void => {
  sharedLimiter = limiter;
};

/** Reset production singleton between isolated tests that exercise real wiring. */
export const resetSharedAdminMutationRateLimiter = (): void => {
  sharedLimiter = null;
};

/**
 * Multi-instance atomic rate limiter for enterprise admin mutations.
 * Production path uses Redis INCR+PEXPIRE; process-local Map is a test double only.
 */
import { createHash } from 'node:crypto';

import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';

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

/** Stable digest so raw actor identifiers never appear in Redis keys. */
export const digestAdminMutationRateScope = (scope: AdminMutationRateLimitScope): string =>
  createHash('sha256').update(`${scope.actorId}\0${scope.procedure}`, 'utf8').digest('hex');

export const adminMutationRateLimitRedisKey = (scopeDigest: string): string =>
  `platform:admin-mutation:rate:${scopeDigest}`;

/**
 * Production multi-instance limiter. Redis absence or eval failure fails closed.
 */
export class SharedAdminMutationRateLimiter implements AdminMutationRateLimiter {
  private readonly config: AdminMutationRateLimitConfig;
  private readonly getRedis: () => RedisEvalClient | null;

  constructor(options?: {
    config?: AdminMutationRateLimitConfig;
    getRedis?: () => RedisEvalClient | null;
  }) {
    this.config = options?.config ?? resolveAdminMutationRateLimitConfig();
    this.getRedis =
      options?.getRedis ?? (() => getAgentRuntimeRedisClient() as RedisEvalClient | null);
  }

  consume = async (scope: AdminMutationRateLimitScope): Promise<AdminMutationRateLimitDecision> => {
    const redis = this.getRedis();
    if (!redis) return 'unavailable';

    const digest = digestAdminMutationRateScope(scope);
    const key = adminMutationRateLimitRedisKey(digest);
    try {
      const count = await redis.eval(CONSUME_SCRIPT, 1, key, String(this.config.windowMs));
      const numeric = Number(count);
      if (!Number.isFinite(numeric) || numeric <= 0) return 'unavailable';
      return numeric <= this.config.limit ? 'allowed' : 'limited';
    } catch {
      return 'unavailable';
    }
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

/** Production singleton. Tests may replace via setSharedAdminMutationRateLimiter. */
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

/**
 * Multi-instance atomic rate limiter for enterprise admin mutations.
 *
 * PostgreSQL is the sole authoritative counter (admin mutations already require
 * serverDatabase). Process-local Map is a unit-test double only.
 */
import { createHash } from 'node:crypto';

import { PlatformAdminMutationRateModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

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
  /**
   * Retain expired windows this long after the window ends before cleanup may drop them.
   * Cleanup is opportunistic and never expands quota.
   */
  retentionMs: 24 * 60 * 60 * 1000,
  /** Max rows deleted per opportunistic cleanup batch. */
  cleanupBatchSize: 200,
  /** Minimum ms between opportunistic cleanup attempts on this process. */
  cleanupMinIntervalMs: 60_000,
  /** Fixed window length in milliseconds. */
  windowMs: 60_000,
} as const;

export type AdminMutationRateLimitDecision = 'allowed' | 'limited' | 'unavailable';

export interface AdminMutationRateLimitConfig {
  cleanupBatchSize: number;
  cleanupMinIntervalMs: number;
  limit: number;
  retentionMs: number;
  windowMs: number;
}

export interface AdminMutationRateLimitScope {
  actorId: string;
  /** Required on the production middleware path. */
  db?: LobeChatDatabase;
  /** Canonical `admin.*` procedure path. */
  procedure: string;
}

export interface AdminMutationRateLimiter {
  consume: (scope: AdminMutationRateLimitScope) => Promise<AdminMutationRateLimitDecision>;
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
  return {
    cleanupBatchSize: ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.cleanupBatchSize,
    cleanupMinIntervalMs: ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.cleanupMinIntervalMs,
    limit,
    retentionMs: ADMIN_MUTATION_RATE_LIMIT_DEFAULTS.retentionMs,
    windowMs,
  };
};

/** Stable digest so raw actor identifiers never appear in PostgreSQL rows. */
export const digestAdminMutationRateScope = (
  scope: Pick<AdminMutationRateLimitScope, 'actorId' | 'procedure'>,
): string =>
  createHash('sha256').update(`${scope.actorId}\0${scope.procedure}`, 'utf8').digest('hex');

/**
 * PostgreSQL is the sole authoritative multi-instance counter.
 */
export class PostgresAdminMutationRateLimiter implements AdminMutationRateLimiter {
  private readonly config: AdminMutationRateLimitConfig;
  private lastCleanupAt = 0;

  constructor(options?: { config?: AdminMutationRateLimitConfig }) {
    this.config = options?.config ?? resolveAdminMutationRateLimitConfig();
  }

  consume = async (scope: AdminMutationRateLimitScope): Promise<AdminMutationRateLimitDecision> => {
    if (!scope.db) return 'unavailable';
    try {
      const digest = digestAdminMutationRateScope(scope);
      const model = new PlatformAdminMutationRateModel(scope.db);
      const result = await model.consume({
        limit: this.config.limit,
        scopeDigest: digest,
        windowMs: this.config.windowMs,
      });
      // Opportunistic bounded cleanup never affects the consume decision.
      void this.maybeCleanup(model);
      return result.allowed ? 'allowed' : 'limited';
    } catch {
      return 'unavailable';
    }
  };

  private maybeCleanup = async (model: PlatformAdminMutationRateModel): Promise<void> => {
    const now = Date.now();
    if (now - this.lastCleanupAt < this.config.cleanupMinIntervalMs) return;
    this.lastCleanupAt = now;
    try {
      await model.cleanupExpired({
        limit: this.config.cleanupBatchSize,
        maxAgeMs: this.config.windowMs + this.config.retentionMs,
      });
    } catch (error) {
      // Sanitized: cleanup failure must not expand quota or fail the request. Log only the
      // error class name (never the error/value) so real cleanup regressions are diagnosable.
      console.error('[admin-mutation-rate] cleanup unavailable', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  };
}

/** @deprecated Alias kept for callers; production uses PostgreSQL only. */
export class SharedAdminMutationRateLimiter extends PostgresAdminMutationRateLimiter {}

/**
 * Process-local test double only. Never used as the production enforcement path.
 */
export class InMemoryAdminMutationRateLimiter implements AdminMutationRateLimiter {
  private readonly config: AdminMutationRateLimitConfig;
  private readonly store: Map<string, { count: number; resetAt: number }>;
  private readonly now: () => number;

  constructor(options?: {
    config?: Partial<AdminMutationRateLimitConfig>;
    now?: () => number;
    store?: Map<string, { count: number; resetAt: number }>;
  }) {
    this.config = {
      ...resolveAdminMutationRateLimitConfig({}),
      ...options?.config,
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
 * Production singleton — PostgreSQL-backed SharedAdminMutationRateLimiter.
 * Unit tests may inject a double via setSharedAdminMutationRateLimiter for isolation.
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

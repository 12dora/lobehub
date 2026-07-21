import { sql } from 'drizzle-orm';

import type { LobeChatDatabase, Transaction } from '../../type';

export interface ConsumeAdminMutationRateWindowParams {
  /** Maximum allowed requests in the window (inclusive). */
  limit: number;
  /** SHA-256 hex digest — never a raw actor id. */
  scopeDigest: string;
  /** Fixed window length in milliseconds. */
  windowMs: number;
}

export interface ConsumeAdminMutationRateWindowResult {
  allowed: boolean;
  count: number;
}

const asRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
};

/**
 * Atomic multi-instance fixed-window counter using the database clock.
 * One statement: insert-or-increment with window rollover, no lock amplification.
 */
export class PlatformAdminMutationRateModel {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

  consume = async (
    params: ConsumeAdminMutationRateWindowParams,
  ): Promise<ConsumeAdminMutationRateWindowResult> => {
    const windowMs = Math.max(1, Math.trunc(params.windowMs));
    const limit = Math.max(1, Math.trunc(params.limit));

    const result = await this.db.execute(sql`
      INSERT INTO platform_admin_mutation_rate_windows (
        scope_digest,
        window_start,
        count,
        updated_at
      )
      VALUES (
        ${params.scopeDigest},
        now(),
        1,
        now()
      )
      ON CONFLICT (scope_digest) DO UPDATE SET
        count = CASE
          WHEN platform_admin_mutation_rate_windows.window_start
            + make_interval(secs => ${windowMs}::double precision / 1000.0)
            <= now()
          THEN 1
          ELSE platform_admin_mutation_rate_windows.count + 1
        END,
        window_start = CASE
          WHEN platform_admin_mutation_rate_windows.window_start
            + make_interval(secs => ${windowMs}::double precision / 1000.0)
            <= now()
          THEN now()
          ELSE platform_admin_mutation_rate_windows.window_start
        END,
        updated_at = now()
      RETURNING count
    `);

    const rows = asRows<{ count: number | string }>(result);
    const count = Number(rows[0]?.count ?? 0);
    if (!Number.isFinite(count) || count <= 0) {
      throw new Error('PLATFORM_ADMIN_MUTATION_RATE_UNAVAILABLE');
    }
    return { allowed: count <= limit, count };
  };

  /**
   * Best-effort retention: delete windows older than `maxAgeMs`.
   *
   * Concurrency safety:
   * - Candidate selection uses `FOR UPDATE SKIP LOCKED` so rows mid-consume are skipped
   *   rather than blocked or deleted after a concurrent reset.
   * - Final DELETE revalidates the sargable expiry predicate so a row that was
   *   concurrently rolled into a fresh window is never deleted.
   *
   * Indexability:
   * - Predicate is `window_start < now() - interval` (column on the left) so the
   *   existing `window_start` btree index can be used; candidates are ordered by
   *   `window_start` with a hard LIMIT.
   *
   * `maxAgeMs` is the sole retention threshold (configured window + retention).
   * All scopes share one server-side limiter config, so a single threshold is exact.
   */
  cleanupExpired = async (params: { limit?: number; maxAgeMs: number }): Promise<number> => {
    const maxAgeMs = Math.max(1, Math.trunc(params.maxAgeMs));
    const limit = Math.min(10_000, Math.max(1, Math.trunc(params.limit ?? 1000)));
    const result = await this.db.execute(sql`
      WITH candidates AS (
        SELECT scope_digest
        FROM platform_admin_mutation_rate_windows
        WHERE window_start < (now() - (${maxAgeMs}::bigint * interval '1 millisecond'))
        ORDER BY window_start ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM platform_admin_mutation_rate_windows AS t
      USING candidates AS c
      WHERE t.scope_digest = c.scope_digest
        AND t.window_start < (now() - (${maxAgeMs}::bigint * interval '1 millisecond'))
      RETURNING t.scope_digest
    `);
    return asRows(result).length;
  };
}

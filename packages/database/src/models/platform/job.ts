import type { AnyColumn, SQL } from 'drizzle-orm';
import { and, asc, desc, eq, gt, inArray, lt, lte, notInArray, or, sql } from 'drizzle-orm';

import {
  type NewPlatformJob,
  PLATFORM_JOB_LEDGER_TYPES,
  type PlatformJobItem,
  platformJobs,
  type PlatformJobStatus,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';

export interface EnqueueJobParams {
  idempotencyKey: string;
  input?: Record<string, unknown>;
  maxAttempts?: number | null;
  progressTotal?: number | null;
  requestedBy?: string | null;
  type: string;
}

export interface ClaimJobParams {
  leaseMs?: number;
  types?: string[];
  workerId: string;
}

export interface ClaimBatchParams {
  /** Per-type lease override. Types omitted here use `leaseMs` / the model default. */
  leaseMs?: number;
  leaseMsByType?: Readonly<Record<string, number>>;
  /**
   * Fallback per-type cap when `limitByType[type]` is omitted. Clamped to [1, 100].
   * This is never a global oldest-N across types.
   */
  limit?: number;
  /** Hard cap per `type`, applied after `FOR UPDATE SKIP LOCKED` (LATERAL LIMIT). */
  limitByType?: Readonly<Record<string, number>>;
  types: readonly string[];
  workerId: string;
}

export interface CheckpointJobParams {
  cursor?: PlatformJobItem['cursor'];
  jobId: string;
  leaseMs?: number;
  progressDone?: number;
  progressTotal?: number | null;
  workerId: string;
}

export interface CompleteJobParams {
  jobId: string;
  resultSummary?: Record<string, unknown> | null;
  workerId: string;
}

export interface FailJobParams {
  error: Record<string, unknown>;
  jobId: string;
  /** When true (or maxAttempts exceeded), move to `dead` instead of `pending` retry. */
  terminal?: boolean;
  workerId: string;
}

export const PLATFORM_JOB_BACKLOG_STATES = [
  'pending',
  'reserved_expired',
  'running_lease_expired',
] as const;

export type PlatformJobBacklogState = (typeof PLATFORM_JOB_BACKLOG_STATES)[number];

export interface PlatformJobBacklogEntry {
  count: number;
  oldestAgeSeconds: number;
  state: PlatformJobBacklogState;
}

export interface PlatformJobBacklogSnapshot {
  entries: PlatformJobBacklogEntry[];
  snapshotAt: Date;
}

export interface AdminPlatformJobCursor {
  createdAt: Date;
  id: string;
}

export interface AdminPlatformJobListParams {
  cursor?: AdminPlatformJobCursor;
  limit?: number;
}

export interface AdminPlatformJobListItem {
  attempt: number;
  createdAt: Date;
  failedCount: number | null;
  finishedAt: Date | null;
  hasError: boolean;
  id: string;
  maxAttempts: number | null;
  progressDone: number;
  progressTotal: number | null;
  revision: number | null;
  startedAt: Date | null;
  status: PlatformJobStatus;
  type: string;
  updatedAt: Date;
}

export interface AdminPlatformJobSummary {
  active: number;
  completed: number;
  failed: number;
  total: number;
}

const DEFAULT_LEASE_MS = 30_000;
const databaseNow = sql<Date>`statement_timestamp()`;

const rowsOf = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
};

const asDate = (value: Date | string | null | undefined): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const coerceClaimedJob = (row: PlatformJobItem): PlatformJobItem => ({
  ...row,
  createdAt: asDate(row.createdAt) ?? row.createdAt,
  finishedAt: asDate(row.finishedAt),
  heartbeatAt: asDate(row.heartbeatAt),
  leaseUntil: asDate(row.leaseUntil),
  startedAt: asDate(row.startedAt),
  updatedAt: asDate(row.updatedAt) ?? row.updatedAt,
});
const databaseLeaseUntil = (leaseMs: number) =>
  sql<Date>`statement_timestamp() + (${leaseMs} * interval '1 millisecond')`;

/**
 * Platform job state machine with idempotent enqueue, lease claim, heartbeat, and retry.
 *
 * Status flow:
 *   pending → running → succeeded | failed | pending(retry) | dead | cancelled
 */
export class PlatformJobModel {
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  /**
   * Idempotent enqueue. Re-submitting the same (type, idempotencyKey) returns the existing row
   * without creating a duplicate or re-running side effects.
   */
  enqueue = async (
    params: EnqueueJobParams,
  ): Promise<{ created: boolean; job: PlatformJobItem }> => {
    const values: NewPlatformJob = {
      idempotencyKey: params.idempotencyKey,
      input: params.input ?? {},
      maxAttempts: params.maxAttempts ?? null,
      progressTotal: params.progressTotal ?? null,
      requestedBy: params.requestedBy ?? null,
      status: 'pending',
      type: params.type,
    };

    const inserted = await this.db
      .insert(platformJobs)
      .values(values)
      .onConflictDoNothing({
        target: [platformJobs.type, platformJobs.idempotencyKey],
      })
      .returning();

    if (inserted[0]) {
      return { created: true, job: inserted[0] };
    }

    const existing = await this.db.query.platformJobs.findFirst({
      where: and(
        eq(platformJobs.type, params.type),
        eq(platformJobs.idempotencyKey, params.idempotencyKey),
      ),
    });

    if (!existing) {
      throw new Error(`Failed to enqueue or load job ${params.type}/${params.idempotencyKey}`);
    }

    return { created: false, job: existing };
  };

  findById = async (id: string): Promise<PlatformJobItem | undefined> => {
    return this.db.query.platformJobs.findFirst({
      where: eq(platformJobs.id, id),
    });
  };

  findByIdempotencyKey = async (
    type: string,
    idempotencyKey: string,
  ): Promise<PlatformJobItem | undefined> => {
    return this.db.query.platformJobs.findFirst({
      where: and(eq(platformJobs.type, type), eq(platformJobs.idempotencyKey, idempotencyKey)),
    });
  };

  /**
   * Reads only work that a worker can claim or clean up now. Terminal rows and active leases are
   * excluded so transition/failure ledgers cannot inflate the operational backlog.
   */
  getBacklogSnapshot = async (): Promise<PlatformJobBacklogSnapshot> => {
    const databaseNow = sql`statement_timestamp()`;
    const isExecutableJob = notInArray(platformJobs.type, [...PLATFORM_JOB_LEDGER_TYPES]);
    const pending = and(isExecutableJob, eq(platformJobs.status, 'pending'))!;
    const reservedExpired = and(
      isExecutableJob,
      eq(platformJobs.status, 'reserved'),
      lte(platformJobs.leaseUntil, databaseNow),
    )!;
    const runningLeaseExpired = and(
      isExecutableJob,
      eq(platformJobs.status, 'running'),
      lte(platformJobs.leaseUntil, databaseNow),
    )!;
    const ageSeconds = (timestamp: AnyColumn, condition: SQL) =>
      sql<number>`greatest(
        0,
        coalesce(
          extract(epoch from ${databaseNow} - min(${timestamp}) filter (where ${condition})),
          0
        )
      )::double precision`;

    const [row] = await this.db
      .select({
        pendingCount: sql<number>`count(*) filter (where ${pending})::int`,
        pendingOldestAgeSeconds: ageSeconds(platformJobs.updatedAt, pending),
        reservedExpiredCount: sql<number>`count(*) filter (where ${reservedExpired})::int`,
        reservedExpiredOldestAgeSeconds: ageSeconds(platformJobs.leaseUntil, reservedExpired),
        runningLeaseExpiredCount: sql<number>`count(*) filter (where ${runningLeaseExpired})::int`,
        runningLeaseExpiredOldestAgeSeconds: ageSeconds(
          platformJobs.leaseUntil,
          runningLeaseExpired,
        ),
        snapshotAt: sql<Date | string>`${databaseNow}`,
      })
      .from(platformJobs)
      .where(or(pending, reservedExpired, runningLeaseExpired));

    const rawSnapshotAt = row?.snapshotAt;
    const snapshotAt =
      rawSnapshotAt instanceof Date ? rawSnapshotAt : new Date(rawSnapshotAt ?? NaN);
    if (Number.isNaN(snapshotAt.getTime())) {
      throw new Error('PLATFORM_JOB_BACKLOG_CLOCK_UNAVAILABLE');
    }

    return {
      entries: [
        {
          count: Number(row?.pendingCount ?? 0),
          oldestAgeSeconds: Number(row?.pendingOldestAgeSeconds ?? 0),
          state: 'pending',
        },
        {
          count: Number(row?.reservedExpiredCount ?? 0),
          oldestAgeSeconds: Number(row?.reservedExpiredOldestAgeSeconds ?? 0),
          state: 'reserved_expired',
        },
        {
          count: Number(row?.runningLeaseExpiredCount ?? 0),
          oldestAgeSeconds: Number(row?.runningLeaseExpiredOldestAgeSeconds ?? 0),
          state: 'running_lease_expired',
        },
      ],
      snapshotAt,
    };
  };

  /**
   * Secret-free operational projection. Raw inputs, cursors, leases, errors, request principals,
   * result summaries, and idempotency keys never cross this model boundary.
   */
  listForAdmin = async (
    params: AdminPlatformJobListParams = {},
  ): Promise<{ items: AdminPlatformJobListItem[]; nextCursor: AdminPlatformJobCursor | null }> => {
    const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 50);
    const executable = notInArray(platformJobs.type, [...PLATFORM_JOB_LEDGER_TYPES]);
    const cursor = params.cursor
      ? or(
          lt(platformJobs.createdAt, params.cursor.createdAt),
          and(
            eq(platformJobs.createdAt, params.cursor.createdAt),
            lt(platformJobs.id, params.cursor.id),
          ),
        )
      : undefined;
    const rows = await this.db
      .select({
        attempt: platformJobs.attempt,
        createdAt: platformJobs.createdAt,
        failedCount: sql<number | null>`case
          when ${platformJobs.resultSummary}->>'failed' ~ '^[0-9]{1,9}$'
            then (${platformJobs.resultSummary}->>'failed')::int
          else null
        end`,
        finishedAt: platformJobs.finishedAt,
        hasError: sql<boolean>`${platformJobs.lastError} is not null`,
        id: platformJobs.id,
        maxAttempts: platformJobs.maxAttempts,
        progressDone: platformJobs.progressDone,
        progressTotal: platformJobs.progressTotal,
        revision: sql<number | null>`case
          when ${platformJobs.input}->'control'->>'revision' ~ '^[0-9]{1,9}$'
            then (${platformJobs.input}->'control'->>'revision')::int
          else null
        end`,
        startedAt: platformJobs.startedAt,
        status: platformJobs.status,
        type: platformJobs.type,
        updatedAt: platformJobs.updatedAt,
      })
      .from(platformJobs)
      .where(and(executable, cursor))
      .orderBy(desc(platformJobs.createdAt), desc(platformJobs.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  };

  getAdminSummary = async (): Promise<AdminPlatformJobSummary> => {
    const executable = notInArray(platformJobs.type, [...PLATFORM_JOB_LEDGER_TYPES]);
    const [row] = await this.db
      .select({
        active: sql<number>`count(*) filter (where ${platformJobs.status} in ('pending', 'reserved', 'running'))::int`,
        completed: sql<number>`count(*) filter (where ${platformJobs.status} in ('succeeded', 'cancelled'))::int`,
        failed: sql<number>`count(*) filter (where ${platformJobs.status} in ('failed', 'dead'))::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(platformJobs)
      .where(executable);
    return {
      active: Number(row?.active ?? 0),
      completed: Number(row?.completed ?? 0),
      failed: Number(row?.failed ?? 0),
      total: Number(row?.total ?? 0),
    };
  };

  /**
   * Claim the next available job for a worker.
   * Eligible: status=pending, or status=running with expired lease (crash recovery),
   * and still within the soft attempt budget (`maxAttempts` null = unlimited).
   * Expired running jobs that already exhausted `maxAttempts` are transitioned to
   * `dead` so they are not reclaimed after an uncaught worker crash.
   */
  claimNext = async (params: ClaimJobParams): Promise<PlatformJobItem | null> => {
    const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
    /** Rows still allowed another claim: unlimited, or attempt count below the cap. */
    const withinAttemptBudget = sql<boolean>`(
      ${platformJobs.maxAttempts} IS NULL
      OR ${platformJobs.attempt} < ${platformJobs.maxAttempts}
    )`;
    const attemptBudgetExhausted = sql<boolean>`(
      ${platformJobs.maxAttempts} IS NOT NULL
      AND ${platformJobs.attempt} >= ${platformJobs.maxAttempts}
    )`;

    return this.db.transaction(async (tx) => {
      const typeFilter =
        params.types && params.types.length > 0
          ? inArray(platformJobs.type, params.types)
          : undefined;

      // Crash recovery: lease-expired work that already burned its attempt budget
      // must not be reclaimed — dead-letter it instead of stranding as `running`.
      await tx
        .update(platformJobs)
        .set({
          finishedAt: databaseNow,
          lastError: sql<Record<string, unknown>>`coalesce(
            ${platformJobs.lastError},
            '{"code":"MAX_ATTEMPTS_EXCEEDED","reason":"lease_expired_after_attempt_budget"}'::jsonb
          )`,
          leaseOwner: null,
          leaseUntil: null,
          status: 'dead',
          updatedAt: databaseNow,
        })
        .where(
          and(
            eq(platformJobs.status, 'running'),
            lte(platformJobs.leaseUntil, databaseNow),
            attemptBudgetExhausted,
            typeFilter,
          ),
        );

      const conditions = [
        or(
          eq(platformJobs.status, 'pending'),
          and(eq(platformJobs.status, 'running'), lte(platformJobs.leaseUntil, databaseNow)),
        )!,
        withinAttemptBudget,
      ];

      if (typeFilter) {
        conditions.push(typeFilter);
      }

      // Prefer oldest pending / expired work. FOR UPDATE prevents double claim.
      // skipLocked lets concurrent workers proceed when another holds a row lock.
      const candidates = await tx
        .select()
        .from(platformJobs)
        .where(and(...conditions))
        .orderBy(asc(platformJobs.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      const candidate = candidates[0];
      if (!candidate) return null;

      // Active non-expired leases for other workers are already excluded by the
      // WHERE clause (pending | running with lease_until <= now). No extra guard.
      // Attempt budget is enforced above so claim cannot push past maxAttempts.

      const nextAttempt = candidate.attempt + 1;
      const [claimed] = await tx
        .update(platformJobs)
        .set({
          attempt: nextAttempt,
          heartbeatAt: databaseNow,
          leaseOwner: params.workerId,
          leaseUntil: databaseLeaseUntil(leaseMs),
          startedAt: sql<Date>`coalesce(${platformJobs.startedAt}, ${databaseNow})`,
          status: 'running',
          updatedAt: databaseNow,
        })
        .where(
          and(
            eq(platformJobs.id, candidate.id),
            or(
              eq(platformJobs.status, 'pending'),
              and(eq(platformJobs.status, 'running'), lte(platformJobs.leaseUntil, databaseNow)),
            ),
            withinAttemptBudget,
          ),
        )
        .returning();

      return claimed ?? null;
    });
  };

  /**
   * Claim a mixed-type batch in one statement. Cap is applied *after*
   * `FOR UPDATE SKIP LOCKED` via a LATERAL subquery per type so a locked
   * oldest row does not starve the next available one. Eligibility matches
   * {@link claimNext}.
   */
  claimBatch = async (params: ClaimBatchParams): Promise<PlatformJobItem[]> => {
    if (params.types.length === 0) return [];
    const types = [...new Set(params.types)];
    const defaultCap = Math.min(Math.max(Math.floor(params.limit ?? 25), 1), 100);
    const defaultLeaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
    const capRows = types.map((type) => {
      const rawCap = params.limitByType?.[type] ?? defaultCap;
      const cap = Math.min(Math.max(Math.floor(rawCap), 1), 100);
      const leaseMs = params.leaseMsByType?.[type] ?? defaultLeaseMs;
      return sql`(${type}, ${cap}::int, ${leaseMs}::int)`;
    });

    const result = await this.db.execute(sql`
      WITH caps(type, cap, lease_ms) AS (
        VALUES ${sql.join(capRows, sql`, `)}
      ),
      dead AS (
        UPDATE platform_jobs
        SET
          finished_at = statement_timestamp(),
          last_error = coalesce(
            last_error,
            '{"code":"MAX_ATTEMPTS_EXCEEDED","reason":"lease_expired_after_attempt_budget"}'::jsonb
          ),
          lease_owner = NULL,
          lease_until = NULL,
          status = 'dead',
          updated_at = statement_timestamp()
        WHERE status = 'running'
          AND lease_until <= statement_timestamp()
          AND max_attempts IS NOT NULL
          AND attempt >= max_attempts
          AND type IN (SELECT type FROM caps)
        RETURNING id
      ),
      picked AS (
        SELECT locked.id, t.lease_ms
        FROM caps t
        CROSS JOIN LATERAL (
          SELECT j.id
          FROM platform_jobs j
          WHERE j.type = t.type
            AND (
              j.status = 'pending'
              OR (j.status = 'running' AND j.lease_until <= statement_timestamp())
            )
            AND (j.max_attempts IS NULL OR j.attempt < j.max_attempts)
            AND NOT EXISTS (SELECT 1 FROM dead d WHERE d.id = j.id)
          ORDER BY j.created_at ASC
          LIMIT t.cap
          FOR UPDATE SKIP LOCKED
        ) locked
      )
      UPDATE platform_jobs AS j
      SET
        attempt = j.attempt + 1,
        heartbeat_at = statement_timestamp(),
        lease_owner = ${params.workerId},
        lease_until = statement_timestamp() + (picked.lease_ms * interval '1 millisecond'),
        started_at = coalesce(j.started_at, statement_timestamp()),
        status = 'running',
        updated_at = statement_timestamp()
      FROM picked
      WHERE j.id = picked.id
      RETURNING
        j.id,
        j.type,
        j.status,
        j.idempotency_key AS "idempotencyKey",
        j.input,
        j.progress_total AS "progressTotal",
        j.progress_done AS "progressDone",
        j.cursor,
        j.result_summary AS "resultSummary",
        j.last_error AS "lastError",
        j.attempt,
        j.max_attempts AS "maxAttempts",
        j.lease_owner AS "leaseOwner",
        j.lease_until AS "leaseUntil",
        j.heartbeat_at AS "heartbeatAt",
        j.requested_by AS "requestedBy",
        j.started_at AS "startedAt",
        j.finished_at AS "finishedAt",
        j.created_at AS "createdAt",
        j.updated_at AS "updatedAt"
    `);

    return rowsOf<PlatformJobItem>(result).map(coerceClaimedJob);
  };

  /**
   * Undo a claim for rows this worker leased but will not process (lane stop /
   * handler throw). Restores `pending` and decrements `attempt` so the row
   * looks as if {@link claimNext} never took it.
   */
  releaseUnprocessed = async (params: {
    jobIds: readonly string[];
    workerId: string;
  }): Promise<number> => {
    if (params.jobIds.length === 0) return 0;
    const rows = await this.db
      .update(platformJobs)
      .set({
        attempt: sql`greatest(${platformJobs.attempt} - 1, 0)`,
        heartbeatAt: null,
        leaseOwner: null,
        leaseUntil: null,
        startedAt: sql<Date | null>`case
          when ${platformJobs.attempt} <= 1 then null
          else ${platformJobs.startedAt}
        end`,
        status: 'pending',
        updatedAt: databaseNow,
      })
      .where(
        and(
          inArray(platformJobs.id, [...params.jobIds]),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformJobs.status, 'running'),
        ),
      )
      .returning({ id: platformJobs.id });
    return rows.length;
  };

  /**
   * Heartbeat + optional cursor/progress checkpoint. Extends the lease.
   * No-op (returns null) if the caller does not own the lease.
   */
  checkpoint = async (params: CheckpointJobParams): Promise<PlatformJobItem | null> => {
    const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;

    const [row] = await this.db
      .update(platformJobs)
      .set({
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.progressDone !== undefined ? { progressDone: params.progressDone } : {}),
        ...(params.progressTotal !== undefined ? { progressTotal: params.progressTotal } : {}),
        heartbeatAt: databaseNow,
        leaseUntil: databaseLeaseUntil(leaseMs),
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformJobs.status, 'running'),
          gt(platformJobs.leaseUntil, databaseNow),
        ),
      )
      .returning();

    return row ?? null;
  };

  heartbeat = async (
    jobId: string,
    workerId: string,
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<PlatformJobItem | null> => {
    return this.checkpoint({ jobId, leaseMs, workerId });
  };

  complete = async (params: CompleteJobParams): Promise<PlatformJobItem | null> => {
    const [row] = await this.db
      .update(platformJobs)
      .set({
        finishedAt: databaseNow,
        lastError: null,
        leaseOwner: null,
        leaseUntil: null,
        resultSummary: params.resultSummary ?? null,
        status: 'succeeded',
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformJobs.status, 'running'),
          gt(platformJobs.leaseUntil, databaseNow),
        ),
      )
      .returning();

    return row ?? null;
  };

  /**
   * Mark failure. By default requeues to `pending` for retry (clearing lease).
   * When maxAttempts is exceeded or `terminal` is set, status becomes `dead`.
   */
  fail = async (params: FailJobParams): Promise<PlatformJobItem | null> => {
    const shouldTerminate = sql<boolean>`(
      ${Boolean(params.terminal)}
      OR (
        ${platformJobs.maxAttempts} IS NOT NULL
        AND ${platformJobs.attempt} >= ${platformJobs.maxAttempts}
      )
    )`;

    const [row] = await this.db
      .update(platformJobs)
      .set({
        finishedAt: sql<Date | null>`case when ${shouldTerminate} then ${databaseNow} else null end`,
        lastError: params.error,
        leaseOwner: null,
        leaseUntil: null,
        status: sql<PlatformJobStatus>`case when ${shouldTerminate} then 'dead' else 'pending' end`,
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformJobs.status, 'running'),
          gt(platformJobs.leaseUntil, databaseNow),
        ),
      )
      .returning();

    return row ?? null;
  };

  cancel = async (jobId: string): Promise<PlatformJobItem | null> => {
    const [row] = await this.db
      .update(platformJobs)
      .set({
        finishedAt: databaseNow,
        leaseOwner: null,
        leaseUntil: null,
        status: 'cancelled',
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(platformJobs.id, jobId),
          or(eq(platformJobs.status, 'pending'), eq(platformJobs.status, 'running')),
        ),
      )
      .returning();

    return row ?? null;
  };
}

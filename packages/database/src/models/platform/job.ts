import { and, asc, eq, inArray, lte, or } from 'drizzle-orm';

import {
  type NewPlatformJob,
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

const DEFAULT_LEASE_MS = 30_000;

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
   * Claim the next available job for a worker.
   * Eligible: status=pending, or status=running with expired lease (crash recovery).
   */
  claimNext = async (params: ClaimJobParams): Promise<PlatformJobItem | null> => {
    const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs);

    return this.db.transaction(async (tx) => {
      const conditions = [
        or(
          eq(platformJobs.status, 'pending'),
          and(eq(platformJobs.status, 'running'), lte(platformJobs.leaseUntil, now)),
        )!,
      ];

      if (params.types && params.types.length > 0) {
        conditions.push(inArray(platformJobs.type, params.types));
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

      const nextAttempt = candidate.attempt + 1;
      const [claimed] = await tx
        .update(platformJobs)
        .set({
          attempt: nextAttempt,
          heartbeatAt: now,
          leaseOwner: params.workerId,
          leaseUntil,
          startedAt: candidate.startedAt ?? now,
          status: 'running',
          updatedAt: now,
        })
        .where(eq(platformJobs.id, candidate.id))
        .returning();

      return claimed ?? null;
    });
  };

  /**
   * Heartbeat + optional cursor/progress checkpoint. Extends the lease.
   * No-op (returns null) if the caller does not own the lease.
   */
  checkpoint = async (params: CheckpointJobParams): Promise<PlatformJobItem | null> => {
    const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs);

    const [row] = await this.db
      .update(platformJobs)
      .set({
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.progressDone !== undefined ? { progressDone: params.progressDone } : {}),
        ...(params.progressTotal !== undefined ? { progressTotal: params.progressTotal } : {}),
        heartbeatAt: now,
        leaseUntil,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformJobs.status, 'running'),
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
    const now = new Date();
    const [row] = await this.db
      .update(platformJobs)
      .set({
        finishedAt: now,
        lastError: null,
        leaseOwner: null,
        leaseUntil: null,
        resultSummary: params.resultSummary ?? null,
        status: 'succeeded',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformJobs.status, 'running'),
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
    const current = await this.findById(params.jobId);
    if (!current) return null;
    if (current.leaseOwner !== params.workerId || current.status !== 'running') {
      return null;
    }

    const now = new Date();
    const hitMax =
      current.maxAttempts !== null &&
      current.maxAttempts !== undefined &&
      current.attempt >= current.maxAttempts;
    const terminal = params.terminal || hitMax;
    const nextStatus: PlatformJobStatus = terminal ? 'dead' : 'pending';

    const [row] = await this.db
      .update(platformJobs)
      .set({
        finishedAt: terminal ? now : null,
        lastError: params.error,
        leaseOwner: null,
        leaseUntil: null,
        status: nextStatus,
        updatedAt: now,
      })
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformJobs.status, 'running'),
        ),
      )
      .returning();

    return row ?? null;
  };

  cancel = async (jobId: string): Promise<PlatformJobItem | null> => {
    const now = new Date();
    const [row] = await this.db
      .update(platformJobs)
      .set({
        finishedAt: now,
        leaseOwner: null,
        leaseUntil: null,
        status: 'cancelled',
        updatedAt: now,
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

import { and, desc, eq, lt, sql } from 'drizzle-orm';

import { platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';

import {
  EMPTY_PLATFORM_SECRET_REWRAP_RESULT,
  parsePlatformSecretRewrapInput,
  parsePlatformSecretRewrapResult,
  PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
  PLATFORM_SECRET_REWRAP_JOB_TYPE,
  platformSecretRewrapIdempotencyKey,
  type PlatformSecretRewrapJobInput,
  platformSecretRewrapJobInputSchema,
  platformSecretRewrapKeyIdSchema,
  platformSecretRewrapTargetKeyIdFromIdempotencyKey,
} from './contracts';
import {
  PlatformSecretRewrapConflictError,
  PlatformSecretRewrapInvalidError,
  PlatformSecretRewrapProviderError,
} from './errors';
import { translatePlatformSecretRewrapPgError } from './pgErrors';

type CoordinatorDatabase = LobeChatDatabase | Transaction;
type PlatformJobRow = typeof platformJobs.$inferSelect;

export const platformSecretRewrapJobRevision = sql<number>`COALESCE((${platformJobs.input}->'control'->>'revision')::int, 0)`;

const projectJob = (job: PlatformJobRow) => {
  const input = parsePlatformSecretRewrapInput(job);
  return {
    counts: parsePlatformSecretRewrapResult(job.resultSummary),
    jobId: job.id,
    revision: input.control.revision,
    status: job.status,
    targetKeyId: input.targetKeyId,
    updatedAt: job.updatedAt,
  };
};

/** Soft-read control.revision from stored JSONB (matches platformSecretRewrapJobRevision SQL). */
const softJobRevision = (job: PlatformJobRow): number => {
  const control = job.input?.control;
  if (control && typeof control === 'object' && !Array.isArray(control)) {
    const revision = (control as { revision?: unknown }).revision;
    if (typeof revision === 'number' && Number.isInteger(revision) && revision >= 0) {
      return revision;
    }
    if (typeof revision === 'string' && /^(?:0|[1-9]\d*)$/.test(revision)) {
      return Number(revision);
    }
  }
  return 0;
};

const softJobRequestId = (job: PlatformJobRow): string | null => {
  const requestId = job.input?.requestId;
  return typeof requestId === 'string' ? requestId : null;
};

/**
 * Build the next-generation job input for a restart.
 * Restart is a state transition: a corrupt/invalid stored payload must not block recovery.
 * Prefer a full parse when possible; otherwise repair from residual fields + idempotency key.
 */
const buildRestartJobInput = (
  job: PlatformJobRow,
  params: { expectedRevision: number; reason: string; requestId: string },
): PlatformSecretRewrapJobInput => {
  const parsed = platformSecretRewrapJobInputSchema.safeParse(job.input);
  if (parsed.success) {
    return {
      ...parsed.data,
      control: { phase: 'scan', revision: parsed.data.control.revision + 1 },
      reason: params.reason,
      requestId: params.requestId,
    };
  }

  const rawTarget = job.input?.targetKeyId;
  const fromInput =
    typeof rawTarget === 'string'
      ? platformSecretRewrapKeyIdSchema.safeParse(rawTarget)
      : { success: false as const };
  const targetKeyId = fromInput.success
    ? fromInput.data
    : platformSecretRewrapTargetKeyIdFromIdempotencyKey(job.idempotencyKey);
  if (!targetKeyId) throw new PlatformSecretRewrapInvalidError();

  return platformSecretRewrapJobInputSchema.parse({
    control: { phase: 'scan', revision: params.expectedRevision + 1 },
    reason: params.reason,
    requestId: params.requestId,
    schemaVersion: 1,
    targetKeyId,
  });
};

const recoverTargetKeyIdForAudit = (job: PlatformJobRow): string | null => {
  const rawTarget = job.input?.targetKeyId;
  if (typeof rawTarget === 'string') {
    const parsed = platformSecretRewrapKeyIdSchema.safeParse(rawTarget);
    if (parsed.success) return parsed.data;
  }
  return platformSecretRewrapTargetKeyIdFromIdempotencyKey(job.idempotencyKey);
};

/**
 * Internal persistence primitives only. S02c2 callers must wrap each mutation
 * and its PlatformAuditService append in the same database transaction before
 * exposing it through an API. This class intentionally writes no audit row.
 */
export class PlatformSecretRewrapCoordinator {
  constructor(private readonly secrets?: PlatformSecretService) {}

  enqueue = async (
    db: CoordinatorDatabase,
    params: {
      reason: string;
      requestId: string;
      requestedBy: string;
      targetKeyId: string;
    },
  ) => {
    if (!this.secrets || this.secrets.keyProviderId !== 'vault') {
      throw new PlatformSecretRewrapProviderError('vault_required');
    }
    const input = platformSecretRewrapJobInputSchema.parse({
      control: { phase: 'scan', revision: 0 },
      reason: params.reason,
      requestId: params.requestId,
      schemaVersion: 1,
      targetKeyId: params.targetKeyId,
    });
    let activeKeyId: string;
    try {
      activeKeyId = await this.secrets.getActiveKeyId();
    } catch {
      throw new PlatformSecretRewrapProviderError('vault_unavailable');
    }
    if (activeKeyId !== input.targetKeyId) {
      throw new PlatformSecretRewrapProviderError('active_key_changed');
    }

    const [active] = await db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          sql`${platformJobs.status} IN ('pending', 'reserved', 'running')`,
        ),
      )
      .for('update')
      .limit(1);
    if (active) {
      const activeInput = parsePlatformSecretRewrapInput(active);
      if (activeInput.targetKeyId !== input.targetKeyId) {
        throw new PlatformSecretRewrapConflictError();
      }
      return projectJob(active);
    }

    // Domain-set version in the key forces a new job after rotation domain expansion
    // so a pre-fix succeeded job for the same targetKeyId is not reused blindly.
    const idempotencyKey = platformSecretRewrapIdempotencyKey(input.targetKeyId);
    let inserted: typeof platformJobs.$inferSelect | undefined;
    try {
      [inserted] = await db
        .insert(platformJobs)
        .values({
          idempotencyKey,
          input,
          maxAttempts: null,
          requestedBy: params.requestedBy,
          resultSummary: EMPTY_PLATFORM_SECRET_REWRAP_RESULT,
          status: 'pending',
          type: PLATFORM_SECRET_REWRAP_JOB_TYPE,
        })
        .onConflictDoNothing({ target: [platformJobs.type, platformJobs.idempotencyKey] })
        .returning();
    } catch (error) {
      throw translatePlatformSecretRewrapPgError(error);
    }
    if (inserted) return projectJob(inserted);

    const [existing] = await db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          eq(platformJobs.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) throw new PlatformSecretRewrapInvalidError();
    const existingInput = parsePlatformSecretRewrapInput(existing);
    if (existingInput.targetKeyId !== input.targetKeyId) {
      throw new PlatformSecretRewrapInvalidError();
    }
    return projectJob(existing);
  };

  get = async (db: CoordinatorDatabase, jobId: string) => {
    const [job] = await db
      .select()
      .from(platformJobs)
      .where(
        and(eq(platformJobs.id, jobId), eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE)),
      )
      .limit(1);
    return job ? projectJob(job) : undefined;
  };

  list = async (db: CoordinatorDatabase, params: { cursor?: string; limit?: number } = {}) => {
    const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 50);
    const rows = await db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          params.cursor ? lt(platformJobs.id, params.cursor) : undefined,
        ),
      )
      .orderBy(desc(platformJobs.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map(projectJob),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  };

  cancel = async (
    db: CoordinatorDatabase,
    params: {
      expectedRevision: number;
      expectedStatus: 'pending' | 'running';
      jobId: string;
    },
  ) => {
    const [current] = await db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          eq(platformJobs.status, params.expectedStatus),
          eq(platformSecretRewrapJobRevision, params.expectedRevision),
        ),
      )
      .for('update')
      .limit(1);
    if (!current) throw new PlatformSecretRewrapConflictError();
    const input = parsePlatformSecretRewrapInput(current);
    const [updated] = await db
      .update(platformJobs)
      .set({
        finishedAt: sql`clock_timestamp()`,
        input: { ...input, control: { ...input.control, revision: input.control.revision + 1 } },
        leaseOwner: null,
        leaseUntil: null,
        status: 'cancelled',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(platformJobs.id, current.id),
          eq(platformJobs.status, params.expectedStatus),
          eq(platformSecretRewrapJobRevision, params.expectedRevision),
        ),
      )
      .returning();
    if (!updated) throw new PlatformSecretRewrapConflictError();
    return projectJob(updated);
  };

  retry = async (
    db: CoordinatorDatabase,
    params: { expectedRevision: number; expectedStatus: 'failed'; jobId: string },
  ) => {
    const [current] = await db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          eq(platformJobs.status, params.expectedStatus),
          eq(platformSecretRewrapJobRevision, params.expectedRevision),
        ),
      )
      .for('update')
      .limit(1);
    if (!current) throw new PlatformSecretRewrapConflictError();
    const [ledger] = await db
      .select({ id: platformJobs.id })
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_FAILURE_TYPE),
          eq(platformJobs.status, 'failed'),
          sql`${platformJobs.input}->>'parentJobId' = ${current.id}`,
        ),
      )
      .limit(1);
    if (!ledger) throw new PlatformSecretRewrapConflictError();
    const input = parsePlatformSecretRewrapInput(current);
    let updated: typeof platformJobs.$inferSelect | undefined;
    try {
      [updated] = await db
        .update(platformJobs)
        .set({
          cursor: null,
          finishedAt: null,
          input: {
            ...input,
            control: { phase: 'failed', revision: input.control.revision + 1 },
          },
          lastError: null,
          leaseOwner: null,
          leaseUntil: null,
          status: 'pending',
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(platformJobs.id, current.id),
            eq(platformJobs.status, params.expectedStatus),
            eq(platformSecretRewrapJobRevision, params.expectedRevision),
          ),
        )
        .returning();
    } catch (error) {
      throw translatePlatformSecretRewrapPgError(error);
    }
    if (!updated) throw new PlatformSecretRewrapConflictError();
    return projectJob(updated);
  };

  /**
   * Restart a cancelled or dead rotation as a new generation on the same job row.
   * Distinct from failed-ledger retry: no failure ledger is required.
   * CAS on (status, revision) makes concurrent double-restart safe (one wins).
   * Single-active unique index rejects restart while another rewrap is active.
   *
   * Same-`requestId` replay is idempotent: after this request already advanced the
   * generation, a repeat returns the post-restart job without conflicting.
   *
   * Restart does not re-validate the terminal payload as a precondition — an
   * `invalid_job_contract` dead row is repaired (or rebuilt from the idempotency key)
   * as part of the transition so recovery stays available through the service.
   *
   * Returns the projected post-restart job plus a terminal-before snapshot so the
   * audited API layer can record diagnostics that this update clears. Replay returns
   * `terminalBefore: null` (already applied).
   */
  restart = async (
    db: CoordinatorDatabase,
    params: {
      expectedRevision: number;
      expectedStatus: 'cancelled' | 'dead';
      jobId: string;
      reason: string;
      requestId: string;
    },
  ) => {
    // Lock by id only so replay can observe the post-restart generation.
    const [current] = await db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
        ),
      )
      .for('update')
      .limit(1);
    if (!current) throw new PlatformSecretRewrapConflictError();

    // Replay-idempotent: this requestId already owns the next generation.
    if (
      softJobRequestId(current) === params.requestId &&
      softJobRevision(current) === params.expectedRevision + 1
    ) {
      return { job: projectJob(current), terminalBefore: null };
    }

    if (
      current.status !== params.expectedStatus ||
      softJobRevision(current) !== params.expectedRevision
    ) {
      throw new PlatformSecretRewrapConflictError();
    }

    // Repair / rebuild input — never require the dead payload to still be valid.
    const nextInput = buildRestartJobInput(current, {
      expectedRevision: params.expectedRevision,
      reason: params.reason,
      requestId: params.requestId,
    });

    // Capture terminal diagnostics before clearing resultSummary / lastError / progress.
    // Counts parsing is best-effort: a corrupt summary must not block recovery restart.
    let terminalCounts = EMPTY_PLATFORM_SECRET_REWRAP_RESULT;
    try {
      terminalCounts = parsePlatformSecretRewrapResult(current.resultSummary);
    } catch {
      /* keep empty counts for beforeDiff */
    }
    const terminalBefore = {
      attempt: current.attempt,
      counts: terminalCounts,
      jobId: current.id,
      lastError:
        current.lastError &&
        typeof current.lastError === 'object' &&
        !Array.isArray(current.lastError)
          ? (current.lastError as Record<string, unknown>)
          : null,
      progressDone: current.progressDone,
      progressTotal: current.progressTotal,
      revision: params.expectedRevision,
      status: current.status,
      targetKeyId: recoverTargetKeyIdForAudit(current) ?? nextInput.targetKeyId,
    };
    let updated: PlatformJobRow | undefined;
    try {
      [updated] = await db
        .update(platformJobs)
        .set({
          attempt: 0,
          cursor: null,
          finishedAt: null,
          heartbeatAt: null,
          input: nextInput,
          lastError: null,
          leaseOwner: null,
          leaseUntil: null,
          // Reset both progress counters together so a restarted job never inherits a
          // stale progressTotal from the terminal run (Done-only reset left total inconsistent).
          progressDone: 0,
          progressTotal: null,
          resultSummary: EMPTY_PLATFORM_SECRET_REWRAP_RESULT,
          startedAt: null,
          status: 'pending',
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(platformJobs.id, current.id),
            eq(platformJobs.status, params.expectedStatus),
            eq(platformSecretRewrapJobRevision, params.expectedRevision),
          ),
        )
        .returning();
    } catch (error) {
      throw translatePlatformSecretRewrapPgError(error);
    }
    if (!updated) throw new PlatformSecretRewrapConflictError();
    return { job: projectJob(updated), terminalBefore };
  };
}

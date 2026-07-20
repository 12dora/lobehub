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
  platformSecretRewrapJobInputSchema,
} from './contracts';
import {
  PlatformSecretRewrapConflictError,
  PlatformSecretRewrapInvalidError,
  PlatformSecretRewrapProviderError,
} from './errors';
import { translatePlatformSecretRewrapPgError } from './pgErrors';

type CoordinatorDatabase = LobeChatDatabase | Transaction;

export const platformSecretRewrapJobRevision = sql<number>`COALESCE((${platformJobs.input}->'control'->>'revision')::int, 0)`;

const projectJob = (job: typeof platformJobs.$inferSelect) => {
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

/**
 * Internal persistence primitives only. S02c2 callers must wrap each mutation
 * and its PlatformAuditService append in the same database transaction before
 * exposing it through an API. This class intentionally writes no audit row.
 */
export class PlatformSecretRewrapCoordinator {
  constructor(private readonly secrets: PlatformSecretService) {}

  enqueue = async (
    db: CoordinatorDatabase,
    params: {
      reason: string;
      requestId: string;
      requestedBy: string;
      targetKeyId: string;
    },
  ) => {
    if (this.secrets.keyProviderId !== 'vault') {
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

    const idempotencyKey = `rewrap:${input.targetKeyId}`;
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
}

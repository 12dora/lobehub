import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  PLATFORM_SECRET_ROTATION_DOMAINS,
  type PlatformSecretRotationCandidate,
  type PlatformSecretRotationDomain,
  PlatformSecretRotationRepository,
} from '@/database/repositories/platformSecretRotation';
import { type PlatformJobItem, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import {
  PlatformSecretError,
  type PlatformSecretService,
} from '@/server/enterprise/security/secret';

import {
  parsePlatformSecretRewrapCursor,
  parsePlatformSecretRewrapInput,
  parsePlatformSecretRewrapResult,
  PLATFORM_SECRET_REWRAP_BATCH_SIZE,
  PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
  PLATFORM_SECRET_REWRAP_JOB_TYPE,
  type PlatformSecretRewrapCursor,
  type PlatformSecretRewrapFailureCategory,
  type PlatformSecretRewrapFailureInput,
  platformSecretRewrapFailureInputSchema,
  type PlatformSecretRewrapJobInput,
  type PlatformSecretRewrapResult,
} from './contracts';
import { platformSecretRewrapJobRevision } from './coordinator';
import { PlatformSecretRewrapInvalidError, PlatformSecretRewrapProviderError } from './errors';

const DEFAULT_LEASE_MS = 60_000;
const failureRowId = sql<string>`${platformJobs.input}->>'rowId'`;

class PlatformSecretRewrapLeaseLostError extends Error {
  constructor() {
    super('PLATFORM_SECRET_REWRAP_LEASE_LOST');
    this.name = 'PlatformSecretRewrapLeaseLostError';
  }
}

/**
 * Extend the job lease on the same transaction connection.
 *
 * Crypto (Vault) work can exceed DEFAULT_LEASE_MS while the batch transaction is
 * still open. Mid-batch + post-provider renewals keep wall-clock leases fresh for
 * observers; checkpoint itself only verifies ownership (not leaseUntil > now).
 * The batch already holds `FOR UPDATE` on the job row, so reclaimers using
 * `SKIP LOCKED` cannot steal it even if the wall-clock lease expired between
 * heartbeats — therefore renew does **not** require `leaseUntil > now`.
 */
const renewLease = async (
  tx: Transaction,
  params: { jobId: string; leaseMs: number; revision: number; workerId: string },
) => {
  const [renewed] = await tx
    .update(platformJobs)
    .set({
      heartbeatAt: sql`clock_timestamp()`,
      leaseUntil: sql`clock_timestamp() + (${params.leaseMs} * interval '1 millisecond')`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(platformJobs.id, params.jobId),
        eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
        eq(platformJobs.status, 'running'),
        eq(platformJobs.leaseOwner, params.workerId),
        eq(platformSecretRewrapJobRevision, params.revision),
      ),
    )
    .returning({ id: platformJobs.id });
  if (!renewed) throw new PlatformSecretRewrapLeaseLostError();
};

export interface PlatformSecretRewrapWorkerLifecycle {
  /** Test/fault seam after the DB-clock claim and before the dedicated transaction. */
  afterClaim?: (job: PlatformJobItem) => Promise<void>;
  /** Test/fault seam after encryption but before the exact data CAS. */
  beforeCandidateCas?: (params: {
    candidate: PlatformSecretRotationCandidate;
    db: Transaction;
  }) => Promise<void>;
  /** Test/fault seam proving data/ledger/checkpoint rollback as one transaction. */
  beforeCheckpoint?: (params: { db: Transaction; job: PlatformJobItem }) => Promise<void>;
}

export interface ProcessPlatformSecretRewrapBatchOptions {
  batchSize?: number;
  leaseMs?: number;
  lifecycle?: PlatformSecretRewrapWorkerLifecycle;
}

export interface ProcessPlatformSecretRewrapBatchResult {
  claimed: boolean;
  jobId?: string;
  terminal?: boolean;
}

interface FailedLedgerItem {
  category: PlatformSecretRewrapFailureCategory;
  domain: PlatformSecretRotationDomain;
  rowId: string;
}

interface FailedLedgerPage {
  items: FailedLedgerItem[];
  nextCursor: PlatformSecretRewrapCursor | null;
}

type CandidateOutcome =
  | { kind: 'failed'; category: PlatformSecretRewrapFailureCategory }
  | { kind: 'no_op' }
  | { kind: 'rotated' };

/**
 * S02c1-specific claim lane. Eligibility and every lease timestamp use the
 * PostgreSQL clock so application-node skew cannot steal or strand a lease.
 */
const claimNextPlatformSecretRewrapJob = async (
  db: LobeChatDatabase,
  params: { leaseMs: number; workerId: string },
): Promise<PlatformJobItem | null> =>
  db.transaction(async (tx) => {
    const available = or(
      eq(platformJobs.status, 'pending'),
      and(eq(platformJobs.status, 'running'), lte(platformJobs.leaseUntil, sql`clock_timestamp()`)),
    );
    const [candidate] = await tx
      .select()
      .from(platformJobs)
      .where(and(eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE), available))
      .orderBy(asc(platformJobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!candidate) return null;

    const [claimed] = await tx
      .update(platformJobs)
      .set({
        attempt: sql`${platformJobs.attempt} + 1`,
        heartbeatAt: sql`clock_timestamp()`,
        leaseOwner: params.workerId,
        leaseUntil: sql`clock_timestamp() + (${params.leaseMs} * interval '1 millisecond')`,
        startedAt: sql`COALESCE(${platformJobs.startedAt}, clock_timestamp())`,
        status: 'running',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(platformJobs.id, candidate.id),
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          available,
        ),
      )
      .returning();
    return claimed ?? null;
  });

const markClaimedDead = async (
  db: LobeChatDatabase,
  params: { category: 'invalid_job_contract'; jobId: string; workerId: string },
) => {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: platformJobs.id })
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          eq(platformJobs.status, 'running'),
          eq(platformJobs.leaseOwner, params.workerId),
          gt(platformJobs.leaseUntil, sql`clock_timestamp()`),
        ),
      )
      .for('update')
      .limit(1);
    if (!current) return;
    await tx
      .update(platformJobs)
      .set({
        finishedAt: sql`clock_timestamp()`,
        lastError: { category: params.category },
        leaseOwner: null,
        leaseUntil: null,
        status: 'dead',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(platformJobs.id, current.id));
  });
};

const assertActiveTarget = async (secrets: PlatformSecretService, targetKeyId: string) => {
  if (secrets.keyProviderId !== 'vault') {
    throw new PlatformSecretRewrapProviderError('vault_required');
  }
  let activeKeyId: string;
  try {
    activeKeyId = await secrets.getActiveKeyId();
  } catch {
    throw new PlatformSecretRewrapProviderError('vault_unavailable');
  }
  if (activeKeyId !== targetKeyId) {
    throw new PlatformSecretRewrapProviderError('active_key_changed');
  }
};

const classifyCryptoFailure = async (
  secrets: PlatformSecretService,
  targetKeyId: string,
  error: unknown,
): Promise<PlatformSecretRewrapFailureCategory> => {
  if (
    error instanceof PlatformSecretError &&
    error.code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT
  ) {
    return 'invalid_ciphertext';
  }
  await assertActiveTarget(secrets, targetKeyId);
  if (error instanceof PlatformSecretError && error.details?.reason === 'unknown-key-id') {
    return 'historical_key_unavailable';
  }
  return 'ciphertext_not_readable';
};

const isAlreadyTarget = (
  secrets: PlatformSecretService,
  candidate: PlatformSecretRotationCandidate,
  targetKeyId: string,
) =>
  candidate.storedKeyId === targetKeyId && secrets.peekKeyId(candidate.ciphertext) === targetKeyId;

const processCandidate = async (
  tx: Transaction,
  secrets: PlatformSecretService,
  candidate: PlatformSecretRotationCandidate,
  targetKeyId: string,
  lifecycle?: PlatformSecretRewrapWorkerLifecycle,
): Promise<CandidateOutcome> => {
  try {
    if (isAlreadyTarget(secrets, candidate, targetKeyId)) return { kind: 'no_op' };
  } catch (error) {
    return { category: await classifyCryptoFailure(secrets, targetKeyId, error), kind: 'failed' };
  }

  let ciphertext: string;
  try {
    ciphertext = await secrets.rotateToKeyId(candidate.ciphertext, targetKeyId);
  } catch (error) {
    return { category: await classifyCryptoFailure(secrets, targetKeyId, error), kind: 'failed' };
  }

  await lifecycle?.beforeCandidateCas?.({ candidate, db: tx });
  const repository = PlatformSecretRotationRepository.forTransaction(tx);
  const updated = await repository.rotateExact({ candidate, ciphertext, targetKeyId });
  if (updated.updated) return { kind: 'rotated' };

  const current = await repository.getById(candidate.domain, candidate.id);
  if (!current) {
    // Row left the active/unexpired inventory between scan and CAS (revoked secret,
    // expired upload, hard delete). Not a permanent concurrent_change deadlock —
    // treat as resolved no-op so the job can finish and historical keys can retire.
    return { kind: 'no_op' };
  }
  try {
    if (isAlreadyTarget(secrets, current, targetKeyId)) return { kind: 'no_op' };
  } catch {
    // A concurrent malformed replacement is a CAS conflict, not this worker's crypto failure.
  }
  return { category: 'concurrent_change', kind: 'failed' };
};

const listFailedLedgers = async (
  tx: Transaction,
  params: {
    cursor: PlatformSecretRewrapCursor | null;
    input: PlatformSecretRewrapJobInput;
    jobId: string;
    limit: number;
  },
): Promise<FailedLedgerPage> => {
  const startIndex = params.cursor
    ? PLATFORM_SECRET_ROTATION_DOMAINS.indexOf(params.cursor.domain)
    : 0;
  if (startIndex < 0) throw new PlatformSecretRewrapInvalidError();

  const items: FailedLedgerItem[] = [];
  for (let index = startIndex; index < PLATFORM_SECRET_ROTATION_DOMAINS.length; index += 1) {
    const domain = PLATFORM_SECRET_ROTATION_DOMAINS[index]!;
    const rows = await tx
      .select({ input: platformJobs.input })
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_FAILURE_TYPE),
          eq(platformJobs.status, 'failed'),
          sql`${platformJobs.input}->>'parentJobId' = ${params.jobId}`,
          sql`${platformJobs.input}->>'domain' = ${domain}`,
          index === startIndex && params.cursor
            ? gt(failureRowId, params.cursor.lastId)
            : undefined,
        ),
      )
      .orderBy(asc(failureRowId))
      .limit(params.limit + 1 - items.length);
    for (const row of rows) {
      const parsed = platformSecretRewrapFailureInputSchema.safeParse(row.input);
      if (
        !parsed.success ||
        parsed.data.parentJobId !== params.jobId ||
        parsed.data.targetKeyId !== params.input.targetKeyId ||
        parsed.data.requestId !== params.input.requestId ||
        parsed.data.domain !== domain
      ) {
        throw new PlatformSecretRewrapInvalidError();
      }
      items.push({
        category: parsed.data.category,
        domain: parsed.data.domain,
        rowId: parsed.data.rowId,
      });
    }
    if (items.length > params.limit) break;
  }

  const pageItems = items.slice(0, params.limit);
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    nextCursor:
      items.length > params.limit && last ? { domain: last.domain, lastId: last.rowId } : null,
  };
};

const failureIdempotencyKey = (parentJobId: string, domain: string, rowId: string) =>
  `${parentJobId}:${domain}:${rowId}`;

const upsertFailureLedger = async (
  tx: Transaction,
  params: {
    category: PlatformSecretRewrapFailureCategory;
    domain: PlatformSecretRotationDomain;
    input: PlatformSecretRewrapJobInput;
    job: PlatformJobItem;
    rowId: string;
  },
) => {
  const input: PlatformSecretRewrapFailureInput = {
    category: params.category,
    domain: params.domain,
    parentJobId: params.job.id,
    parentRevision: params.input.control.revision,
    requestId: params.input.requestId,
    rowId: params.rowId,
    schemaVersion: 1,
    targetKeyId: params.input.targetKeyId,
  };
  const rows = await tx
    .insert(platformJobs)
    .values({
      finishedAt: sql`clock_timestamp()`,
      idempotencyKey: failureIdempotencyKey(params.job.id, params.domain, params.rowId),
      input,
      lastError: { category: params.category },
      maxAttempts: 1,
      progressDone: 0,
      progressTotal: 1,
      status: 'failed',
      type: PLATFORM_SECRET_REWRAP_FAILURE_TYPE,
    })
    .onConflictDoUpdate({
      set: {
        finishedAt: sql`clock_timestamp()`,
        input,
        lastError: { category: params.category },
        progressDone: 0,
        status: 'failed',
        updatedAt: sql`clock_timestamp()`,
      },
      target: [platformJobs.type, platformJobs.idempotencyKey],
      where: and(
        sql`${platformJobs.input}->>'parentJobId' = ${params.job.id}`,
        sql`${platformJobs.input}->>'domain' = ${params.domain}`,
        sql`${platformJobs.input}->>'rowId' = ${params.rowId}`,
      ),
    })
    .returning({ id: platformJobs.id });
  if (rows.length !== 1) throw new PlatformSecretRewrapInvalidError();
};

const markFailureResolved = async (
  tx: Transaction,
  params: { domain: PlatformSecretRotationDomain; jobId: string; rowId: string },
) => {
  const [updated] = await tx
    .update(platformJobs)
    .set({
      finishedAt: sql`clock_timestamp()`,
      lastError: null,
      progressDone: 1,
      status: 'succeeded',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(platformJobs.type, PLATFORM_SECRET_REWRAP_FAILURE_TYPE),
        eq(
          platformJobs.idempotencyKey,
          failureIdempotencyKey(params.jobId, params.domain, params.rowId),
        ),
        eq(platformJobs.status, 'failed'),
        sql`${platformJobs.input}->>'parentJobId' = ${params.jobId}`,
        sql`${platformJobs.input}->>'domain' = ${params.domain}`,
        sql`${platformJobs.input}->>'rowId' = ${params.rowId}`,
      ),
    )
    .returning({ id: platformJobs.id });
  if (!updated) throw new PlatformSecretRewrapInvalidError();
};

const copyResult = (result: PlatformSecretRewrapResult): PlatformSecretRewrapResult => ({
  ...result,
  categories: { ...result.categories },
});

const applyOutcome = (
  result: PlatformSecretRewrapResult,
  outcome: CandidateOutcome,
  previousFailure?: PlatformSecretRewrapFailureCategory,
) => {
  const next = copyResult(result);
  if (previousFailure) {
    next.failed -= 1;
    next.categories[previousFailure] -= 1;
  } else {
    next.examined += 1;
  }
  if (outcome.kind === 'rotated') next.rotated += 1;
  if (outcome.kind === 'no_op') next.noOp += 1;
  if (outcome.kind === 'failed') {
    next.failed += 1;
    next.categories[outcome.category] += 1;
  }
  return next;
};

export const processNextPlatformSecretRewrapBatch = async (
  db: LobeChatDatabase,
  secrets: PlatformSecretService,
  workerId: string,
  options: ProcessPlatformSecretRewrapBatchOptions = {},
): Promise<ProcessPlatformSecretRewrapBatchResult> => {
  const batchSize = Math.min(
    Math.max(Math.floor(options.batchSize ?? PLATFORM_SECRET_REWRAP_BATCH_SIZE), 1),
    PLATFORM_SECRET_REWRAP_BATCH_SIZE,
  );
  const leaseMs = Math.max(Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS), 1);
  const claimed = await claimNextPlatformSecretRewrapJob(db, {
    leaseMs,
    workerId,
  });
  if (!claimed) return { claimed: false };

  let claimedInput: PlatformSecretRewrapJobInput;
  try {
    claimedInput = parsePlatformSecretRewrapInput(claimed);
  } catch {
    await markClaimedDead(db, {
      category: 'invalid_job_contract',
      jobId: claimed.id,
      workerId,
    });
    return { claimed: true, jobId: claimed.id, terminal: true };
  }

  await options.lifecycle?.afterClaim?.(claimed);
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(platformJobs)
        .where(
          and(
            eq(platformJobs.id, claimed.id),
            eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
            eq(platformJobs.status, 'running'),
            eq(platformJobs.leaseOwner, workerId),
            eq(platformSecretRewrapJobRevision, claimedInput.control.revision),
            gt(platformJobs.leaseUntil, sql`clock_timestamp()`),
          ),
        )
        .for('update')
        .limit(1);
      if (!current) throw new PlatformSecretRewrapLeaseLostError();

      let input: PlatformSecretRewrapJobInput;
      let cursor: PlatformSecretRewrapCursor | null;
      let result: PlatformSecretRewrapResult;
      try {
        input = parsePlatformSecretRewrapInput(current);
        cursor = parsePlatformSecretRewrapCursor(current.cursor);
        result = parsePlatformSecretRewrapResult(current.resultSummary);
      } catch {
        throw new PlatformSecretRewrapInvalidError();
      }
      await assertActiveTarget(secrets, input.targetKeyId);

      let terminal: boolean;
      let checkpointCursor = cursor;
      if (input.control.phase === 'scan') {
        const page = await PlatformSecretRotationRepository.forTransaction(tx).listCandidates({
          cursor: cursor ? { domain: cursor.domain, id: cursor.lastId } : undefined,
          limit: batchSize,
          targetKeyId: input.targetKeyId,
        });
        for (const candidate of page.items) {
          // Renew before crypto so a slow Vault path cannot expire the lease
          // before the first row finishes.
          await renewLease(tx, {
            jobId: current.id,
            leaseMs,
            revision: input.control.revision,
            workerId,
          });
          const outcome = await processCandidate(
            tx,
            secrets,
            candidate,
            input.targetKeyId,
            options.lifecycle,
          );
          result = applyOutcome(result, outcome);
          if (outcome.kind === 'failed') {
            await upsertFailureLedger(tx, {
              category: outcome.category,
              domain: candidate.domain,
              input,
              job: current,
              rowId: candidate.id,
            });
          }
          checkpointCursor = { domain: candidate.domain, lastId: candidate.id };
        }
        terminal = page.nextCursor === null;
      } else {
        const page = await listFailedLedgers(tx, {
          cursor,
          input,
          jobId: current.id,
          limit: batchSize,
        });
        const repository = PlatformSecretRotationRepository.forTransaction(tx);
        for (const failure of page.items) {
          await renewLease(tx, {
            jobId: current.id,
            leaseMs,
            revision: input.control.revision,
            workerId,
          });
          const candidate = await repository.getById(failure.domain, failure.rowId);
          // Missing inventory row on retry = already out of rotation scope (revoked /
          // expired). Mark resolved instead of looping concurrent_change forever.
          const outcome = candidate
            ? await processCandidate(tx, secrets, candidate, input.targetKeyId, options.lifecycle)
            : ({ kind: 'no_op' } as const);
          result = applyOutcome(result, outcome, failure.category);
          if (outcome.kind === 'failed') {
            await upsertFailureLedger(tx, {
              category: outcome.category,
              domain: failure.domain,
              input,
              job: current,
              rowId: failure.rowId,
            });
          } else {
            await markFailureResolved(tx, {
              domain: failure.domain,
              jobId: current.id,
              rowId: failure.rowId,
            });
          }
          checkpointCursor = { domain: failure.domain, lastId: failure.rowId };
        }
        terminal = page.nextCursor === null;
      }

      // Final renew before slow commit-boundary work (Vault revalidation / hooks).
      await renewLease(tx, {
        jobId: current.id,
        leaseMs,
        revision: input.control.revision,
        workerId,
      });
      // Revalidate at the commit boundary. A Vault outage or active-key drift
      // after the first row must roll back data, ledger, cursor, and checkpoint.
      await assertActiveTarget(secrets, input.targetKeyId);
      await options.lifecycle?.beforeCheckpoint?.({ db: tx, job: current });
      // Renew again after every potentially slow final operation. A single
      // provider call longer than leaseMs must not make checkpoint fail and
      // re-run the batch forever. Ownership is still verified below under FOR UPDATE.
      await renewLease(tx, {
        jobId: current.id,
        leaseMs,
        revision: input.control.revision,
        workerId,
      });
      const nextInput: PlatformSecretRewrapJobInput = {
        ...input,
        control: { ...input.control, revision: input.control.revision + 1 },
      };
      const completed = result.rotated + result.noOp;
      const total = result.rotated + result.noOp + result.failed;
      // Checkpoint ownership: status/owner/revision under the same FOR UPDATE
      // connection. Do **not** require leaseUntil > now — a provider call that
      // outlasts leaseMs already passed while we held the row lock; reclaimers
      // use SKIP LOCKED and cannot steal this connection's lock.
      const [checkpointed] = await tx
        .update(platformJobs)
        .set({
          cursor: checkpointCursor,
          ...(terminal
            ? {
                finishedAt: sql`clock_timestamp()`,
                lastError: result.failed > 0 ? { category: 'secret_rewrap_items_failed' } : null,
                leaseOwner: null,
                leaseUntil: null,
                progressTotal: total,
                status: result.failed > 0 ? ('failed' as const) : ('succeeded' as const),
              }
            : {
                heartbeatAt: sql`clock_timestamp()`,
                leaseOwner: null,
                leaseUntil: null,
                status: 'pending' as const,
              }),
          input: nextInput,
          progressDone: completed,
          resultSummary: result,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(platformJobs.id, current.id),
            eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
            eq(platformJobs.status, 'running'),
            eq(platformJobs.leaseOwner, workerId),
            eq(platformSecretRewrapJobRevision, input.control.revision),
          ),
        )
        .returning({ id: platformJobs.id });
      if (!checkpointed) throw new PlatformSecretRewrapLeaseLostError();
      return { claimed: true, jobId: current.id, terminal };
    });
  } catch (error) {
    if (error instanceof PlatformSecretRewrapLeaseLostError) {
      return { claimed: true, jobId: claimed.id, terminal: false };
    }
    if (error instanceof PlatformSecretRewrapInvalidError) {
      await markClaimedDead(db, {
        category: 'invalid_job_contract',
        jobId: claimed.id,
        workerId,
      });
      return { claimed: true, jobId: claimed.id, terminal: true };
    }
    throw error;
  }
};

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
type RewrapDatabase = LobeChatDatabase | Transaction;

class PlatformSecretRewrapLeaseLostError extends Error {
  constructor() {
    super('PLATFORM_SECRET_REWRAP_LEASE_LOST');
    this.name = 'PlatformSecretRewrapLeaseLostError';
  }
}

/**
 * Extend the job lease in a short statement between remote crypto calls.
 * No Vault call runs while a database transaction or row lock is held.
 */
const renewLease = async (
  db: RewrapDatabase,
  params: { jobId: string; leaseMs: number; revision: number; workerId: string },
) => {
  const [renewed] = await db
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
  /** Test/fault seam immediately before the short final checkpoint transaction commits. */
  beforeCheckpoint?: (params: { db: Transaction; job: PlatformJobItem }) => Promise<void>;
}

export interface ProcessPlatformSecretRewrapBatchOptions {
  batchSize?: number;
  /**
   * Already-claimed job. When set, this entry point skips the rewrap-specific
   * claim lane so a mixed-type dispatcher can own the SELECT … FOR UPDATE.
   */
  claimed?: PlatformJobItem;
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

type PreparedCandidate =
  | CandidateOutcome
  | {
      ciphertext: string;
      kind: 'prepared';
    };

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

/** Remote-only phase. No database transaction or lock is held here. */
const prepareCandidate = async (
  secrets: PlatformSecretService,
  candidate: PlatformSecretRotationCandidate,
  targetKeyId: string,
): Promise<PreparedCandidate> => {
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

  return { ciphertext, kind: 'prepared' };
};

/** Short transactional phase: exact CAS plus conflict classification. */
const commitPreparedCandidate = async (
  tx: Transaction,
  secrets: PlatformSecretService,
  candidate: PlatformSecretRotationCandidate,
  prepared: PreparedCandidate,
  targetKeyId: string,
  lifecycle?: PlatformSecretRewrapWorkerLifecycle,
): Promise<CandidateOutcome> => {
  if (prepared.kind !== 'prepared') return prepared;
  await lifecycle?.beforeCandidateCas?.({ candidate, db: tx });
  const repository = PlatformSecretRotationRepository.forTransaction(tx);
  const updated = await repository.rotateExact({
    candidate,
    ciphertext: prepared.ciphertext,
    targetKeyId,
  });
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
  db: RewrapDatabase,
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
    const rows = await db
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
  const claimed =
    options.claimed ??
    (await claimNextPlatformSecretRewrapJob(db, {
      leaseMs,
      workerId,
    }));
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
    let cursor: PlatformSecretRewrapCursor | null;
    try {
      cursor = parsePlatformSecretRewrapCursor(claimed.cursor);
    } catch {
      throw new PlatformSecretRewrapInvalidError();
    }
    const repository = new PlatformSecretRotationRepository(db);

    const commitCandidate = async (params: {
      candidate: PlatformSecretRotationCandidate | null;
      domain: PlatformSecretRotationDomain;
      prepared: PreparedCandidate;
      previousFailure?: PlatformSecretRewrapFailureCategory;
      rowId: string;
    }): Promise<void> =>
      db.transaction(async (tx) => {
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
            ),
          )
          .for('update')
          .limit(1);
        if (!current) throw new PlatformSecretRewrapLeaseLostError();

        let input: PlatformSecretRewrapJobInput;
        let result: PlatformSecretRewrapResult;
        try {
          input = parsePlatformSecretRewrapInput(current);
          result = parsePlatformSecretRewrapResult(current.resultSummary);
        } catch {
          throw new PlatformSecretRewrapInvalidError();
        }
        const outcome = params.candidate
          ? await commitPreparedCandidate(
              tx,
              secrets,
              params.candidate,
              params.prepared,
              input.targetKeyId,
              options.lifecycle,
            )
          : ({ kind: 'no_op' } as const);
        result = applyOutcome(result, outcome, params.previousFailure);
        if (outcome.kind === 'failed') {
          await upsertFailureLedger(tx, {
            category: outcome.category,
            domain: params.domain,
            input,
            job: current,
            rowId: params.rowId,
          });
        } else if (params.previousFailure) {
          await markFailureResolved(tx, {
            domain: params.domain,
            jobId: current.id,
            rowId: params.rowId,
          });
        }
        const completed = result.rotated + result.noOp;
        const [checkpointed] = await tx
          .update(platformJobs)
          .set({
            cursor: { domain: params.domain, lastId: params.rowId },
            heartbeatAt: sql`clock_timestamp()`,
            leaseUntil: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
            progressDone: completed,
            resultSummary: result,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(platformJobs.id, current.id),
              eq(platformJobs.status, 'running'),
              eq(platformJobs.leaseOwner, workerId),
              eq(platformSecretRewrapJobRevision, input.control.revision),
            ),
          )
          .returning({ id: platformJobs.id });
        if (!checkpointed) throw new PlatformSecretRewrapLeaseLostError();
      });

    const prepareAndCommit = async (params: {
      candidate: PlatformSecretRotationCandidate | null;
      domain: PlatformSecretRotationDomain;
      previousFailure?: PlatformSecretRewrapFailureCategory;
      rowId: string;
    }) => {
      await renewLease(db, {
        jobId: claimed.id,
        leaseMs,
        revision: claimedInput.control.revision,
        workerId,
      });
      const prepared = params.candidate
        ? await prepareCandidate(secrets, params.candidate, claimedInput.targetKeyId)
        : ({ kind: 'no_op' } as const);
      // A slow provider call may outlive the lease. Renewing here proves another
      // worker did not reclaim ownership while no row lock was held.
      await renewLease(db, {
        jobId: claimed.id,
        leaseMs,
        revision: claimedInput.control.revision,
        workerId,
      });
      // Revalidate immediately before the short secret CAS transaction.
      await assertActiveTarget(secrets, claimedInput.targetKeyId);
      await commitCandidate({ ...params, prepared });
    };

    let terminal: boolean;
    if (claimedInput.control.phase === 'scan') {
      const page = await repository.listCandidates({
        cursor: cursor ? { domain: cursor.domain, id: cursor.lastId } : undefined,
        limit: batchSize,
        targetKeyId: claimedInput.targetKeyId,
      });
      for (const candidate of page.items) {
        await prepareAndCommit({
          candidate,
          domain: candidate.domain,
          rowId: candidate.id,
        });
      }
      terminal = page.nextCursor === null;
    } else {
      const page = await listFailedLedgers(db, {
        cursor,
        input: claimedInput,
        jobId: claimed.id,
        limit: batchSize,
      });
      for (const failure of page.items) {
        const candidate = await repository.getById(failure.domain, failure.rowId);
        await prepareAndCommit({
          candidate: candidate ?? null,
          domain: failure.domain,
          previousFailure: failure.category,
          rowId: failure.rowId,
        });
      }
      terminal = page.nextCursor === null;
    }

    await renewLease(db, {
      jobId: claimed.id,
      leaseMs,
      revision: claimedInput.control.revision,
      workerId,
    });
    await assertActiveTarget(secrets, claimedInput.targetKeyId);
    await renewLease(db, {
      jobId: claimed.id,
      leaseMs,
      revision: claimedInput.control.revision,
      workerId,
    });

    await db.transaction(async (tx) => {
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
          ),
        )
        .for('update')
        .limit(1);
      if (!current) throw new PlatformSecretRewrapLeaseLostError();
      let input: PlatformSecretRewrapJobInput;
      let result: PlatformSecretRewrapResult;
      try {
        input = parsePlatformSecretRewrapInput(current);
        result = parsePlatformSecretRewrapResult(current.resultSummary);
      } catch {
        throw new PlatformSecretRewrapInvalidError();
      }
      await options.lifecycle?.beforeCheckpoint?.({ db: tx, job: current });
      const nextInput: PlatformSecretRewrapJobInput = {
        ...input,
        control: { ...input.control, revision: input.control.revision + 1 },
      };
      const completed = result.rotated + result.noOp;
      const total = completed + result.failed;
      const [checkpointed] = await tx
        .update(platformJobs)
        .set({
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
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(platformJobs.id, current.id),
            eq(platformJobs.status, 'running'),
            eq(platformJobs.leaseOwner, workerId),
            eq(platformSecretRewrapJobRevision, input.control.revision),
          ),
        )
        .returning({ id: platformJobs.id });
      if (!checkpointed) throw new PlatformSecretRewrapLeaseLostError();
    });
    return { claimed: true, jobId: claimed.id, terminal };
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

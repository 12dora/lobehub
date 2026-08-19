import { and, eq, sql } from 'drizzle-orm';

import type {
  PlatformSecretRotationCandidate,
  PlatformSecretRotationDomain,
} from '@/database/repositories/platformSecretRotation';
import { type PlatformJobItem, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';

import {
  parsePlatformSecretRewrapInput,
  parsePlatformSecretRewrapResult,
  PLATFORM_SECRET_REWRAP_JOB_TYPE,
  type PlatformSecretRewrapFailureCategory,
  type PlatformSecretRewrapJobInput,
  type PlatformSecretRewrapResult,
} from './contracts';
import { platformSecretRewrapJobRevision } from './coordinator';
import { PlatformSecretRewrapInvalidError } from './errors';
import type { PreparedCandidate } from './workerCandidate';
import { commitPreparedCandidate } from './workerCandidate';
import { PlatformSecretRewrapLeaseLostError } from './workerClaim';
import { applyOutcome, markFailureResolved, upsertFailureLedger } from './workerLedger';

interface RewrapCheckpointLifecycle {
  beforeCandidateCas?: (params: {
    candidate: PlatformSecretRotationCandidate;
    db: Transaction;
  }) => Promise<void>;
  beforeCheckpoint?: (params: { db: Transaction; job: PlatformJobItem }) => Promise<void>;
}

export const commitRewrapCandidate = async (
  db: LobeChatDatabase,
  secrets: PlatformSecretService,
  params: {
    candidate: PlatformSecretRotationCandidate | null;
    domain: PlatformSecretRotationDomain;
    input: PlatformSecretRewrapJobInput;
    job: PlatformJobItem;
    leaseMs: number;
    lifecycle?: RewrapCheckpointLifecycle;
    prepared: PreparedCandidate;
    previousFailure?: PlatformSecretRewrapFailureCategory;
    rowId: string;
    workerId: string;
  },
): Promise<void> =>
  db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.id, params.job.id),
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          eq(platformJobs.status, 'running'),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformSecretRewrapJobRevision, params.input.control.revision),
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
          params.lifecycle,
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
        leaseUntil: sql`clock_timestamp() + (${params.leaseMs} * interval '1 millisecond')`,
        progressDone: completed,
        resultSummary: result,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(platformJobs.id, current.id),
          eq(platformJobs.status, 'running'),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformSecretRewrapJobRevision, input.control.revision),
        ),
      )
      .returning({ id: platformJobs.id });
    if (!checkpointed) throw new PlatformSecretRewrapLeaseLostError();
  });

export const checkpointRewrapBatch = async (
  db: LobeChatDatabase,
  params: {
    input: PlatformSecretRewrapJobInput;
    job: PlatformJobItem;
    lifecycle?: RewrapCheckpointLifecycle;
    terminal: boolean;
    workerId: string;
  },
): Promise<void> =>
  db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.id, params.job.id),
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          eq(platformJobs.status, 'running'),
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformSecretRewrapJobRevision, params.input.control.revision),
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
    await params.lifecycle?.beforeCheckpoint?.({ db: tx, job: current });
    const nextInput: PlatformSecretRewrapJobInput = {
      ...input,
      control: { ...input.control, revision: input.control.revision + 1 },
    };
    const completed = result.rotated + result.noOp;
    const total = completed + result.failed;
    const [checkpointed] = await tx
      .update(platformJobs)
      .set({
        ...(params.terminal
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
          eq(platformJobs.leaseOwner, params.workerId),
          eq(platformSecretRewrapJobRevision, input.control.revision),
        ),
      )
      .returning({ id: platformJobs.id });
    if (!checkpointed) throw new PlatformSecretRewrapLeaseLostError();
  });

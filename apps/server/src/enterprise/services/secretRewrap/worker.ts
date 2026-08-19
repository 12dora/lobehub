import type {
  PlatformSecretRotationCandidate,
  PlatformSecretRotationDomain,
} from '@/database/repositories/platformSecretRotation';
import { PlatformSecretRotationRepository } from '@/database/repositories/platformSecretRotation';
import type { PlatformJobItem } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';

import {
  parsePlatformSecretRewrapCursor,
  parsePlatformSecretRewrapInput,
  PLATFORM_SECRET_REWRAP_BATCH_SIZE,
  type PlatformSecretRewrapCursor,
  type PlatformSecretRewrapFailureCategory,
  type PlatformSecretRewrapJobInput,
} from './contracts';
import { PlatformSecretRewrapInvalidError } from './errors';
import { assertActiveTarget, prepareCandidate } from './workerCandidate';
import { checkpointRewrapBatch, commitRewrapCandidate } from './workerCheckpoint';
import {
  claimNextPlatformSecretRewrapJob,
  markClaimedDead,
  PlatformSecretRewrapLeaseLostError,
  renewLease,
} from './workerClaim';
import { listFailedLedgers } from './workerLedger';

const DEFAULT_LEASE_MS = 60_000;

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
      await commitRewrapCandidate(db, secrets, {
        ...params,
        input: claimedInput,
        job: claimed,
        leaseMs,
        lifecycle: options.lifecycle,
        prepared,
        workerId,
      });
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

    await checkpointRewrapBatch(db, {
      input: claimedInput,
      job: claimed,
      lifecycle: options.lifecycle,
      terminal,
      workerId,
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

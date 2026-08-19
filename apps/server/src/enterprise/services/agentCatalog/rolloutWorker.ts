import { and, eq, gt, sql } from 'drizzle-orm';

import { PlatformJobModel } from '@/database/models/platform/job';
import type { PlatformJobItem } from '@/database/schemas/platform';
import { platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  PlatformAgentRevisionConflictError,
} from './errors';
import type { PlatformAgentRolloutJobInput } from './rolloutService';
import { parsePlatformAgentRolloutInput, PLATFORM_AGENT_ROLLOUT_JOB_TYPE } from './rolloutService';
import { runRolloutBatchTransaction } from './rolloutWorkerBatch';

const databaseNow = sql<Date>`statement_timestamp()`;

export class PlatformAgentRolloutLeaseLostError extends Error {
  constructor() {
    super('PLATFORM_AGENT_ROLLOUT_LEASE_LOST');
    this.name = 'PlatformAgentRolloutLeaseLostError';
  }
}

export interface PlatformAgentRolloutWorkerLifecycle {
  /** Fault/delay seam used by lease-expiry and mixed-outcome verification. */
  beforeBulkWrite?: (params: {
    db: Transaction;
    job: PlatformJobItem;
    previousByUserId: ReadonlyMap<string, { checksum: string; versionId: string } | null>;
    userIds: string[];
  }) => Promise<ReadonlySet<string> | void>;
  /** Delay seam before poison dead-mark CAS (invalid payload / snapshot conflict). */
  beforeMarkClaimedDead?: (params: {
    category: string;
    jobId: string;
    workerId: string;
  }) => Promise<void>;
}

export interface ProcessPlatformAgentRolloutBatchOptions {
  /**
   * Already-claimed job. When set, this entry point skips `claimNext` so a
   * mixed-type dispatcher can own the SELECT … FOR UPDATE SKIP LOCKED.
   */
  claimed?: PlatformJobItem;
  leaseMs?: number;
  lifecycle?: PlatformAgentRolloutWorkerLifecycle;
}

export interface ProcessPlatformAgentRolloutBatchResult {
  claimed: boolean;
  jobId?: string;
  terminal?: boolean;
}

/**
 * Lease-guarded poison transition. Returns true only when this worker still owns a live lease
 * and the row moved to `dead`; callers must not report `terminal: true` after a lost race.
 */
const markClaimedDead = async (
  db: LobeChatDatabase,
  params: { category: string; jobId: string; workerId: string },
): Promise<boolean> => {
  const [updated] = await db
    .update(platformJobs)
    .set({
      finishedAt: databaseNow,
      lastError: { category: params.category },
      leaseOwner: null,
      leaseUntil: null,
      status: 'dead',
      updatedAt: databaseNow,
    })
    .where(
      and(
        eq(platformJobs.id, params.jobId),
        eq(platformJobs.status, 'running'),
        eq(platformJobs.leaseOwner, params.workerId),
        gt(platformJobs.leaseUntil, databaseNow),
      ),
    )
    .returning({ id: platformJobs.id });
  return Boolean(updated);
};

export const processNextPlatformAgentRolloutBatch = async (
  db: LobeChatDatabase,
  workerId: string,
  options: ProcessPlatformAgentRolloutBatchOptions = {},
): Promise<ProcessPlatformAgentRolloutBatchResult> => {
  const jobs = new PlatformJobModel(db);
  const claimed =
    options.claimed ??
    (await jobs.claimNext({
      leaseMs: options.leaseMs ?? 60_000,
      types: [PLATFORM_AGENT_ROLLOUT_JOB_TYPE],
      workerId,
    }));
  if (!claimed) return { claimed: false };

  let claimedInput: PlatformAgentRolloutJobInput;
  try {
    claimedInput = parsePlatformAgentRolloutInput(claimed);
  } catch {
    await options.lifecycle?.beforeMarkClaimedDead?.({
      category: 'invalid_rollout_snapshot',
      jobId: claimed.id,
      workerId,
    });
    const markedDead = await markClaimedDead(db, {
      category: 'invalid_rollout_snapshot',
      jobId: claimed.id,
      workerId,
    });
    return { claimed: true, jobId: claimed.id, terminal: markedDead };
  }

  try {
    return await db.transaction(async (tx) =>
      runRolloutBatchTransaction(tx, {
        claimed,
        claimedInput,
        lifecycle: options.lifecycle,
        workerId,
      }),
    );
  } catch (error) {
    if (error instanceof PlatformAgentRolloutLeaseLostError) {
      return { claimed: true, jobId: claimed.id, terminal: false };
    }
    if (
      error instanceof PlatformAgentInvalidInputError ||
      error instanceof PlatformAgentNotFoundError ||
      error instanceof PlatformAgentRevisionConflictError
    ) {
      await options.lifecycle?.beforeMarkClaimedDead?.({
        category: 'rollout_snapshot_changed',
        jobId: claimed.id,
        workerId,
      });
      const markedDead = await markClaimedDead(db, {
        category: 'rollout_snapshot_changed',
        jobId: claimed.id,
        workerId,
      });
      return { claimed: true, jobId: claimed.id, terminal: markedDead };
    }
    throw error;
  }
};

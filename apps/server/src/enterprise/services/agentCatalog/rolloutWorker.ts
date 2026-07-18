import type { PlatformAgentAssignmentTargetType } from '@lobechat/types';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { PlatformJobModel } from '@/database/models/platform/job';
import {
  acquirePlatformAgentReferenceLock,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import { type PlatformJobItem, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  PlatformAgentRevisionConflictError,
} from './errors';
import {
  getPlatformAgentRolloutResult,
  parsePlatformAgentRolloutInput,
  PLATFORM_AGENT_ROLLOUT_BATCH_SIZE,
  PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
  PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
  type PlatformAgentRolloutJobInput,
  platformAgentRolloutJobRevision,
  type PlatformAgentRolloutTransitionInput,
  platformAgentRolloutTransitionInputSchema,
} from './rolloutService';

const transitionUserId = sql<string>`${platformJobs.input}->>'userId'`;

class PlatformAgentRolloutLeaseLostError extends Error {
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
}

export interface ProcessPlatformAgentRolloutBatchOptions {
  leaseMs?: number;
  lifecycle?: PlatformAgentRolloutWorkerLifecycle;
}

export interface ProcessPlatformAgentRolloutBatchResult {
  claimed: boolean;
  jobId?: string;
  terminal?: boolean;
}

interface TransitionTarget {
  previousVersionChecksum: string | null;
  previousVersionId: string | null;
  userId: string;
}

const listFailedTransitions = async (
  tx: Transaction,
  params: { cursor?: string; parentJobId: string },
) => {
  const rows = await tx
    .select({ input: platformJobs.input })
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE),
        eq(platformJobs.status, 'failed'),
        sql`${platformJobs.input}->>'parentJobId' = ${params.parentJobId}`,
        params.cursor ? gt(transitionUserId, params.cursor) : undefined,
      ),
    )
    .orderBy(asc(transitionUserId))
    .limit(PLATFORM_AGENT_ROLLOUT_BATCH_SIZE + 1);
  const parsed = rows.map(({ input }) => {
    const result = platformAgentRolloutTransitionInputSchema.safeParse(input);
    if (!result.success) throw new PlatformAgentInvalidInputError();
    return result.data;
  });
  const hasMore = parsed.length > PLATFORM_AGENT_ROLLOUT_BATCH_SIZE;
  const items = hasMore ? parsed.slice(0, PLATFORM_AGENT_ROLLOUT_BATCH_SIZE) : parsed;
  return { items, nextCursor: hasMore ? (items.at(-1)?.userId ?? null) : null };
};

const upsertTransitionLedger = async (
  tx: Transaction,
  params: {
    appliedUserIds: ReadonlySet<string>;
    input: PlatformAgentRolloutJobInput;
    job: PlatformJobItem;
    targets: TransitionTarget[];
  },
) => {
  if (params.targets.length === 0) return;
  if (params.targets.length > PLATFORM_AGENT_ROLLOUT_BATCH_SIZE) {
    throw new PlatformAgentInvalidInputError();
  }
  const { snapshot } = params.input;
  const values = params.targets.map((target) => {
    const succeeded = params.appliedUserIds.has(target.userId);
    const input: PlatformAgentRolloutTransitionInput = {
      assignmentId: snapshot.assignmentId,
      parentAttempt: params.job.attempt,
      parentJobId: params.job.id,
      parentRevision: params.input.control.revision,
      previousVersionChecksum: target.previousVersionChecksum,
      previousVersionId: target.previousVersionId,
      targetId: snapshot.targetId,
      targetType: snapshot.targetType,
      targetVersionChecksum: snapshot.targetVersionChecksum,
      targetVersionId: snapshot.targetVersionId,
      userId: target.userId,
      versionPolicy: snapshot.versionPolicy,
    };
    return {
      finishedAt: succeeded ? new Date() : null,
      idempotencyKey: `${params.job.id}:${target.userId}`,
      input,
      lastError: succeeded ? null : { category: 'materialization_failed' },
      maxAttempts: 1,
      progressDone: succeeded ? 1 : 0,
      progressTotal: 1,
      status: succeeded ? ('succeeded' as const) : ('failed' as const),
      type: PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
    };
  });
  const ledgerRows = await tx
    .insert(platformJobs)
    .values(values)
    .onConflictDoUpdate({
      set: {
        finishedAt: sql`CASE WHEN ${platformJobs.status} = 'succeeded' THEN ${platformJobs.finishedAt} ELSE excluded.finished_at END`,
        input: sql`${platformJobs.input} || jsonb_build_object('parentAttempt', excluded.input->'parentAttempt', 'parentRevision', excluded.input->'parentRevision')`,
        lastError: sql`CASE WHEN ${platformJobs.status} = 'succeeded' THEN NULL ELSE excluded.last_error END`,
        progressDone: sql`CASE WHEN ${platformJobs.status} = 'succeeded' THEN 1 ELSE excluded.progress_done END`,
        status: sql`CASE WHEN ${platformJobs.status} = 'succeeded' THEN 'succeeded' ELSE excluded.status END`,
        updatedAt: new Date(),
      },
      target: [platformJobs.type, platformJobs.idempotencyKey],
      where: and(
        sql`${platformJobs.input}->>'parentJobId' = excluded.input->>'parentJobId'`,
        sql`${platformJobs.input}->>'assignmentId' = excluded.input->>'assignmentId'`,
        sql`${platformJobs.input}->>'targetType' = excluded.input->>'targetType'`,
        sql`${platformJobs.input}->>'targetId' = excluded.input->>'targetId'`,
        sql`${platformJobs.input}->>'userId' = excluded.input->>'userId'`,
        sql`${platformJobs.input}->>'versionPolicy' = excluded.input->>'versionPolicy'`,
        sql`${platformJobs.input}->>'targetVersionId' = excluded.input->>'targetVersionId'`,
        sql`${platformJobs.input}->>'targetVersionChecksum' = excluded.input->>'targetVersionChecksum'`,
        sql`(${platformJobs.input}->>'previousVersionId') IS NOT DISTINCT FROM (excluded.input->>'previousVersionId')`,
        sql`(${platformJobs.input}->>'previousVersionChecksum') IS NOT DISTINCT FROM (excluded.input->>'previousVersionChecksum')`,
        sql`COALESCE((${platformJobs.input}->>'parentAttempt')::int, 0) <= (excluded.input->>'parentAttempt')::int`,
      ),
    })
    .returning({ id: platformJobs.id });
  if (ledgerRows.length !== params.targets.length) {
    throw new PlatformAgentRevisionConflictError();
  }
};

const deriveUniformPrevious = async (
  tx: Transaction,
  params: { parentJobId: string; targetVersionId: string; total: number },
) => {
  if (params.total === 0) return { checksum: null, versionId: null };
  const [proof] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      maxChecksum: sql<string | null>`max(${platformJobs.input}->>'previousVersionChecksum')`,
      maxVersionId: sql<string | null>`max(${platformJobs.input}->>'previousVersionId')`,
      minChecksum: sql<string | null>`min(${platformJobs.input}->>'previousVersionChecksum')`,
      minVersionId: sql<string | null>`min(${platformJobs.input}->>'previousVersionId')`,
      nullCount: sql<number>`count(*) FILTER (WHERE ${platformJobs.input}->>'previousVersionId' IS NULL OR ${platformJobs.input}->>'previousVersionChecksum' IS NULL)::int`,
    })
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE),
        sql`${platformJobs.input}->>'parentJobId' = ${params.parentJobId}`,
      ),
    );
  const uniform =
    proof &&
    proof.count === params.total &&
    proof.nullCount === 0 &&
    proof.minVersionId === proof.maxVersionId &&
    proof.minChecksum === proof.maxChecksum &&
    proof.minVersionId !== params.targetVersionId;
  return uniform
    ? { checksum: proof.minChecksum, versionId: proof.minVersionId }
    : { checksum: null, versionId: null };
};

const markClaimedDead = async (
  db: LobeChatDatabase,
  params: { category: string; jobId: string; workerId: string },
) => {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: platformJobs.id })
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.id, params.jobId),
          eq(platformJobs.status, 'running'),
          eq(platformJobs.leaseOwner, params.workerId),
          gt(platformJobs.leaseUntil, now),
        ),
      )
      .for('update')
      .limit(1);
    if (!locked) return;
    await tx
      .update(platformJobs)
      .set({
        finishedAt: now,
        lastError: { category: params.category },
        leaseOwner: null,
        leaseUntil: null,
        status: 'dead',
        updatedAt: now,
      })
      .where(eq(platformJobs.id, locked.id));
  });
};

const validateSnapshot = async (tx: Transaction, input: PlatformAgentRolloutJobInput) => {
  const repository = new PlatformAgentCatalogRepository(tx);
  const { snapshot } = input;
  await acquirePlatformAgentReferenceLock(tx, snapshot.agentId);
  const identity = await repository.lockIdentity(snapshot.agentId);
  if (
    !identity ||
    identity.status !== 'published' ||
    identity.migrationRequired ||
    identity.systemKey === 'default-inbox'
  ) {
    throw new PlatformAgentRevisionConflictError();
  }
  const assignment = await repository.getAssignment(snapshot.agentId, snapshot.assignmentId);
  if (
    !assignment ||
    !assignment.enabled ||
    assignment.status !== 'active' ||
    assignment.targetType !== snapshot.targetType ||
    assignment.targetId !== snapshot.targetId ||
    assignment.versionPolicy !== snapshot.versionPolicy ||
    (snapshot.versionPolicy === 'pinned' &&
      assignment.pinnedVersionId !== snapshot.targetVersionId) ||
    (snapshot.versionPolicy === 'latest_published' &&
      identity.currentVersionId !== snapshot.targetVersionId)
  ) {
    throw new PlatformAgentRevisionConflictError();
  }
  const version = await repository.getExactVersion(snapshot.agentId, snapshot.targetVersionId);
  if (!version || version.checksum !== snapshot.targetVersionChecksum) {
    throw new PlatformAgentRevisionConflictError();
  }
  return repository;
};

export const processNextPlatformAgentRolloutBatch = async (
  db: LobeChatDatabase,
  workerId: string,
  options: ProcessPlatformAgentRolloutBatchOptions = {},
): Promise<ProcessPlatformAgentRolloutBatchResult> => {
  const jobs = new PlatformJobModel(db);
  const claimed = await jobs.claimNext({
    leaseMs: options.leaseMs ?? 60_000,
    types: [PLATFORM_AGENT_ROLLOUT_JOB_TYPE],
    workerId,
  });
  if (!claimed) return { claimed: false };

  let claimedInput: PlatformAgentRolloutJobInput;
  try {
    claimedInput = parsePlatformAgentRolloutInput(claimed);
  } catch {
    await markClaimedDead(db, {
      category: 'invalid_rollout_snapshot',
      jobId: claimed.id,
      workerId,
    });
    return { claimed: true, jobId: claimed.id, terminal: true };
  }

  try {
    return await db.transaction(async (tx) => {
      const startedAt = new Date();
      const [current] = await tx
        .select()
        .from(platformJobs)
        .where(
          and(
            eq(platformJobs.id, claimed.id),
            eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
            eq(platformJobs.status, 'running'),
            eq(platformJobs.leaseOwner, workerId),
            eq(platformAgentRolloutJobRevision, claimedInput.control.revision),
            gt(platformJobs.leaseUntil, startedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!current) throw new PlatformAgentRolloutLeaseLostError();
      const input = parsePlatformAgentRolloutInput(current);
      const repository = await validateSnapshot(tx, input);
      const currentResult = getPlatformAgentRolloutResult(current);
      const completedBefore = current.progressDone;
      const failedBefore = currentResult.failed;
      let nextCursor: string | null;
      let sourceTargets: Array<{
        previousVersionChecksum: string | null;
        previousVersionId: string | null;
        userId: string;
      }>;
      if (input.control.phase === 'failed') {
        const failures = await listFailedTransitions(tx, {
          cursor: typeof current.cursor === 'string' ? current.cursor : undefined,
          parentJobId: current.id,
        });
        sourceTargets = failures.items.map((item) => ({
          previousVersionChecksum: item.previousVersionChecksum,
          previousVersionId: item.previousVersionId,
          userId: item.userId,
        }));
        nextCursor = failures.nextCursor;
      } else {
        const page = await repository.listAssignmentTargetUserIds({
          cutoff: new Date(input.snapshot.targetCutoff),
          cursor: typeof current.cursor === 'string' ? current.cursor : undefined,
          limit: PLATFORM_AGENT_ROLLOUT_BATCH_SIZE,
          targetId: input.snapshot.targetId,
          targetType: input.snapshot.targetType as PlatformAgentAssignmentTargetType,
        });
        sourceTargets = page.items.map((userId) => ({
          previousVersionChecksum: null,
          previousVersionId: null,
          userId,
        }));
        nextCursor = page.nextCursor;
      }

      const applied = await repository.bulkCasRolloutMaterializations({
        beforeWrite: async (previousByUserId) =>
          options.lifecycle?.beforeBulkWrite?.({
            db: tx,
            job: current,
            previousByUserId,
            userIds: sourceTargets.map(({ userId }) => userId),
          }),
        platformAgentId: input.snapshot.agentId,
        targetVersionChecksum: input.snapshot.targetVersionChecksum,
        targetVersionId: input.snapshot.targetVersionId,
        targets: sourceTargets,
      });
      const ledgerTargets = sourceTargets.map((target) => {
        const observed = applied.previousByUserId.get(target.userId);
        return {
          previousVersionChecksum: target.previousVersionChecksum ?? observed?.checksum ?? null,
          previousVersionId: target.previousVersionId ?? observed?.versionId ?? null,
          userId: target.userId,
        };
      });
      await upsertTransitionLedger(tx, {
        appliedUserIds: applied.appliedUserIds,
        input,
        job: current,
        targets: ledgerTargets,
      });

      const succeeded = applied.appliedUserIds.size;
      const failedThisPage = sourceTargets.length - succeeded;
      const completed = completedBefore + succeeded;
      const failed =
        input.control.phase === 'failed' ? failedBefore - succeeded : failedBefore + failedThisPage;
      const cursor =
        sourceTargets.at(-1)?.userId ??
        (typeof current.cursor === 'string' ? current.cursor : null);
      const terminal = nextCursor === null;
      const actualTotal = terminal ? completed + failed : (current.progressTotal ?? 0);
      const previous = terminal
        ? await deriveUniformPrevious(tx, {
            parentJobId: current.id,
            targetVersionId: input.snapshot.targetVersionId,
            total: actualTotal,
          })
        : {
            checksum: currentResult.previousVersionChecksum ?? null,
            versionId: currentResult.previousVersionId ?? null,
          };
      const nextInput = {
        ...input,
        control: { ...input.control, revision: input.control.revision + 1 },
      };
      const checkpointAt = new Date();
      const [checkpointed] = await tx
        .update(platformJobs)
        .set({
          cursor,
          ...(terminal
            ? {
                finishedAt: checkpointAt,
                lastError: failed > 0 ? { category: 'rollout_items_failed' } : null,
                leaseOwner: null,
                leaseUntil: null,
                status: failed > 0 ? ('failed' as const) : ('succeeded' as const),
              }
            : {
                heartbeatAt: checkpointAt,
                leaseOwner: null,
                leaseUntil: null,
                status: 'pending' as const,
              }),
          input: nextInput,
          progressDone: completed,
          progressTotal: actualTotal,
          resultSummary: {
            failed,
            previousVersionChecksum: previous.checksum,
            previousVersionId: previous.versionId,
          },
          updatedAt: checkpointAt,
        })
        .where(
          and(
            eq(platformJobs.id, current.id),
            eq(platformJobs.status, 'running'),
            eq(platformJobs.leaseOwner, workerId),
            eq(platformAgentRolloutJobRevision, input.control.revision),
            gt(platformJobs.leaseUntil, checkpointAt),
          ),
        )
        .returning({ id: platformJobs.id });
      if (!checkpointed) throw new PlatformAgentRolloutLeaseLostError();
      return { claimed: true, jobId: claimed.id, terminal };
    });
  } catch (error) {
    if (error instanceof PlatformAgentRolloutLeaseLostError) {
      return { claimed: true, jobId: claimed.id, terminal: false };
    }
    if (
      error instanceof PlatformAgentInvalidInputError ||
      error instanceof PlatformAgentNotFoundError ||
      error instanceof PlatformAgentRevisionConflictError
    ) {
      await markClaimedDead(db, {
        category: 'rollout_snapshot_changed',
        jobId: claimed.id,
        workerId,
      });
      return { claimed: true, jobId: claimed.id, terminal: true };
    }
    throw error;
  }
};

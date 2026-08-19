import type { PlatformAgentAssignmentTargetType } from '@lobechat/types';
import { and, eq, gt, sql } from 'drizzle-orm';

import type { PlatformJobItem } from '@/database/schemas/platform';
import { platformJobs } from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import type { PlatformAgentRolloutJobInput } from './rolloutService';
import {
  getPlatformAgentRolloutResult,
  parsePlatformAgentRolloutInput,
  PLATFORM_AGENT_ROLLOUT_BATCH_SIZE,
  PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
  platformAgentRolloutJobRevision,
} from './rolloutService';
import type {
  PlatformAgentRolloutWorkerLifecycle,
  ProcessPlatformAgentRolloutBatchResult,
} from './rolloutWorker';
import { PlatformAgentRolloutLeaseLostError } from './rolloutWorker';
import {
  deriveUniformPrevious,
  listFailedTransitions,
  upsertTransitionLedger,
} from './rolloutWorkerLedger';
import { validateSnapshot } from './rolloutWorkerSnapshot';

const databaseNow = sql<Date>`statement_timestamp()`;

export const runRolloutBatchTransaction = async (
  tx: Transaction,
  params: {
    claimed: PlatformJobItem;
    claimedInput: PlatformAgentRolloutJobInput;
    lifecycle?: PlatformAgentRolloutWorkerLifecycle;
    workerId: string;
  },
): Promise<ProcessPlatformAgentRolloutBatchResult> => {
  const { claimed, claimedInput, lifecycle, workerId } = params;
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
        gt(platformJobs.leaseUntil, databaseNow),
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
      cutoff: input.snapshot.targetCutoff,
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
      lifecycle?.beforeBulkWrite?.({
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
    sourceTargets.at(-1)?.userId ?? (typeof current.cursor === 'string' ? current.cursor : null);
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
  const [checkpointed] = await tx
    .update(platformJobs)
    .set({
      cursor,
      ...(terminal
        ? {
            finishedAt: databaseNow,
            lastError: failed > 0 ? { category: 'rollout_items_failed' } : null,
            leaseOwner: null,
            leaseUntil: null,
            status: failed > 0 ? ('failed' as const) : ('succeeded' as const),
          }
        : {
            heartbeatAt: databaseNow,
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
      updatedAt: databaseNow,
    })
    .where(
      and(
        eq(platformJobs.id, current.id),
        eq(platformJobs.status, 'running'),
        eq(platformJobs.leaseOwner, workerId),
        eq(platformAgentRolloutJobRevision, input.control.revision),
        gt(platformJobs.leaseUntil, databaseNow),
      ),
    )
    .returning({ id: platformJobs.id });
  if (!checkpointed) throw new PlatformAgentRolloutLeaseLostError();
  return { claimed: true, jobId: claimed.id, terminal };
};
